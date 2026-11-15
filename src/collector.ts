import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import {
  projectForCwd,
  type ServiceConfig,
  type SourceConfig,
} from './config.ts';
import {
  type CollectionScanSummary,
  type CollectionSourceStatus,
  type CollectionState,
  type CollectionStatus,
} from './api.ts';
import { Archive, sourceFiles } from './store.ts';
import { readSessionTitles, titleLookup, type TitleLookup } from './titles.ts';
import { ArchiveError, hash, type JsonObject } from './types.ts';

/**
 * Persistent pieces owned by the collection scheduler. They live beside the
 * archive tables but never change event identity or the v1 batch contract.
 */
export const DEFAULT_LEASE_TTL_MS = 300_000;
const MAX_SOURCE_FILES = 10_000;

const COLLECTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS collection_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS collection_sources (
  source_key TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  root TEXT NOT NULL,
  baselined INTEGER NOT NULL DEFAULT 0,
  scope_hash TEXT NOT NULL,
  last_scan_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  last_error_at TEXT
);
CREATE TABLE IF NOT EXISTS collection_files (
  source_key TEXT NOT NULL,
  file_id TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  ctime_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0,
  scope_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_key, file_id)
);
CREATE INDEX IF NOT EXISTS collection_files_path ON collection_files(source_key, path);
`;

export function ensureCollectionSchema(db: DatabaseSync): void {
  db.exec(COLLECTION_SCHEMA);
}

export interface CollectionLeaseResult {
  acquired: boolean;
  owner: string | null;
  expires_at: number | null;
}

/**
 * Acquire the single collection lease stored in the archive database. The
 * transaction makes concurrent starts race-free; an expired lease can be
 * taken over, but a live foreign owner is never displaced.
 */
export function acquireCollectionLease(
  db: DatabaseSync,
  owner: string,
  ttlMs = DEFAULT_LEASE_TTL_MS,
  now = Date.now(),
): CollectionLeaseResult {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new ArchiveError('INVALID_INPUT', 'lease TTL must be positive');
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT owner,expires_at FROM collection_lease WHERE id=1').get();
    if (row) {
      const existingOwner = String(row.owner);
      const expiresAt = Number(row.expires_at);
      if (existingOwner !== owner && expiresAt > now) {
        db.exec('ROLLBACK');
        return { acquired: false, owner: existingOwner, expires_at: expiresAt };
      }
    }
    db.prepare(`INSERT INTO collection_lease(id,owner,acquired_at,expires_at) VALUES(1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at`)
      .run(owner, now, now + ttlMs);
    db.exec('COMMIT');
    return { acquired: true, owner, expires_at: now + ttlMs };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  }
}

export function renewCollectionLease(
  db: DatabaseSync,
  owner: string,
  ttlMs = DEFAULT_LEASE_TTL_MS,
  now = Date.now(),
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT owner FROM collection_lease WHERE id=1').get();
    if (!row || String(row.owner) !== owner) throw new ArchiveError('COLLECTION_LEASE_LOST', 'Collection lease is no longer owned by this process');
    db.prepare('UPDATE collection_lease SET expires_at=? WHERE id=1').run(now + ttlMs);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  }
}

export function releaseCollectionLease(db: DatabaseSync, owner: string): boolean {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT owner FROM collection_lease WHERE id=1').get();
    if (!row || String(row.owner) !== owner) { db.exec('COMMIT'); return false; }
    db.prepare('DELETE FROM collection_lease WHERE id=1').run();
    db.exec('COMMIT');
    return true;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  }
}

export function sourceKey(source: SourceConfig): string {
  return JSON.stringify([source.instance_id, source.root]);
}

/** Fingerprint only the project scopes; reordering equivalent scopes is harmless. */
export function sourceScopeHash(source: SourceConfig): string {
  const projects = source.projects
    .map(project => [project.project_id, [...project.cwd_allowlist].sort()] as const)
    .sort((left, right) => left[0].localeCompare(right[0]));
  // Only include the fallback when configured, so existing archives keep their
  // scope hash; enabling it must invalidate skip decisions for unmatched files.
  if (source.unmatched_project_id === undefined) return hash(JSON.stringify(projects));
  return hash(JSON.stringify([projects, source.unmatched_project_id]));
}

type FileOutcome = 'imported' | 'baselined' | 'unmatched';

interface FileState {
  file_id: string;
  path: string;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
  outcome: FileOutcome;
  pending: number;
  scope_hash: string;
  updated_at: string;
}

interface SourceState {
  baselined: boolean;
  scope_hash: string;
  last_scan_at: string | null;
  last_error: { code: string; message: string; at: string } | null;
}

interface FileVersion {
  file_id: string;
  path: string;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
}

export interface CollectorOptions {
  /** Tests can shorten or control lease timing; production uses the defaults. */
  leaseTtlMs?: number;
  now?: () => number;
  onFatal?: (error: ArchiveError) => void;
  onScan?: (summary: CollectionScanSummary, state: CollectionState) => void;
  /** Test hook; production always uses the configured interval. */
  scheduleScans?: boolean;
}

function isoTimestamp(now: number): string {
  return new Date(now).toISOString();
}

function errorRecord(error: unknown, at: string): { code: string; message: string; at: string } {
  const code = error instanceof ArchiveError
    ? error.code
    : typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code: string }).code) : 'SOURCE_ERROR';
  const message = error instanceof Error ? error.message : 'Unknown source error';
  return { code, message, at };
}

function emptySummary(): CollectionScanSummary {
  return { files: 0, imported: 0, skipped: 0, pending: 0, unmatched_projects: 0, errors: 0 };
}

/**
 * Foreground collection scheduler. Every scan discovers the selected files
 * again, re-reads changed files in full, and relies on the existing archive
 * transaction/dedup logic. For imported content the file checkpoint is written
 * only after that file's archive transaction commits; crashes therefore cause
 * a re-read, never a silently skipped event. Baseline and unmatched outcomes are
 * explicit no-import decisions keyed to the file version and project-scope
 * fingerprint, so a config change re-evaluates them.
 */
export class Collector {
  readonly config: ServiceConfig;
  readonly archive: Archive;
  private readonly leaseTtlMs: number;
  private readonly now: () => number;
  private readonly onFatal?: (error: ArchiveError) => void;
  private readonly onScan?: (summary: CollectionScanSummary, state: CollectionState) => void;
  private readonly scheduleScans: boolean;
  private leaseOwner: string | null = null;
  private started = false;
  private stopping = false;
  private scanTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private currentScan: Promise<CollectionScanSummary> | null = null;
  private sourceStates = new Map<string, SourceState>();
  private sourceStatuses = new Map<string, CollectionSourceStatus>();
  private state: CollectionState;
  private startedAt: string;
  private heartbeatAt: string | null = null;
  private lastScanStartedAt: string | null = null;
  private lastScanFinishedAt: string | null = null;
  private lastScan: CollectionScanSummary | null = null;
  private lastError: { code: string; message: string; at: string } | null = null;

  constructor(config: ServiceConfig, archive: Archive, options: CollectorOptions = {}) {
    this.config = config;
    this.archive = archive;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.onFatal = options.onFatal;
    this.onScan = options.onScan;
    this.scheduleScans = options.scheduleScans ?? true;
    this.state = config.collection.enabled ? 'starting' : 'disabled';
    this.startedAt = isoTimestamp(this.now());
    ensureCollectionSchema(archive.db);
    this.loadPersistedSourceState();
  }

  private loadPersistedSourceState(): void {
    this.sourceStates.clear();
    this.sourceStatuses.clear();
    for (const source of this.config.collection.sources) {
      const key = sourceKey(source);
      const row = this.archive.db.prepare(`SELECT baselined,scope_hash,last_scan_at,last_error_code,last_error_message,last_error_at
        FROM collection_sources WHERE source_key=?`).get(key);
      const lastError = row && row.last_error_code
        ? { code: String(row.last_error_code), message: String(row.last_error_message ?? ''), at: String(row.last_error_at ?? '') }
        : null;
      this.sourceStates.set(key, {
        baselined: Number(row?.baselined ?? 0) === 1,
        scope_hash: String(row?.scope_hash ?? ''),
        last_scan_at: row?.last_scan_at === null || row?.last_scan_at === undefined ? null : String(row.last_scan_at),
        last_error: lastError,
      });
      this.sourceStatuses.set(key, {
        instance_id: source.instance_id,
        root: source.root,
        project_ids: source.projects.map(project => project.project_id),
        last_scan_at: row?.last_scan_at === null || row?.last_scan_at === undefined ? null : String(row.last_scan_at),
        last_error: lastError,
      });
    }
  }

  start(): void {
    if (this.started) return;
    this.stopping = false;
    if (!this.config.collection.enabled) {
      this.started = true;
      this.state = 'disabled';
      this.heartbeatAt = isoTimestamp(this.now());
      // API-only service still reports a live process heartbeat.
      this.heartbeatTimer = setInterval(() => this.heartbeat(), 15_000);
      return;
    }
    const owner = `agent-trace-${process.pid}-${randomUUID()}`;
    const lease = acquireCollectionLease(this.archive.db, owner, this.leaseTtlMs, this.now());
    if (!lease.acquired) {
      throw new ArchiveError('COLLECTION_LOCKED', `Another collection instance owns the archive lease until ${new Date(lease.expires_at ?? 0).toISOString()}`);
    }
    this.leaseOwner = owner;
    this.started = true;
    this.stopping = false;
    this.state = 'idle';
    const heartbeatMs = Math.max(1_000, Math.min(15_000, Math.floor(this.leaseTtlMs / 3)));
    this.heartbeatAt = isoTimestamp(this.now());
    this.heartbeatTimer = setInterval(() => this.heartbeat(), heartbeatMs);
    if (this.scheduleScans) this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.stopping || !this.config.collection.enabled) return;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopping || !this.config.collection.enabled) return;
    try {
      await this.scanOnce();
    } catch (error) {
      const record = errorRecord(error, isoTimestamp(this.now()));
      this.lastError = record;
      this.state = 'degraded';
      const archiveError = error instanceof ArchiveError ? error : new ArchiveError('SCAN_FAILED', record.message);
      if (archiveError.code === 'COLLECTION_LEASE_LOST') {
        this.stopping = true;
        this.clearTimers();
      }
      this.onFatal?.(archiveError);
    }
    if (!this.stopping && this.config.collection.enabled) this.schedule(this.config.collection.scan_interval_seconds * 1_000);
  }

  private heartbeat(): void {
    if (this.stopping) return;
    this.heartbeatAt = isoTimestamp(this.now());
    if (!this.leaseOwner) return;
    try {
      renewCollectionLease(this.archive.db, this.leaseOwner, this.leaseTtlMs, this.now());
    } catch (error) {
      const record = errorRecord(error, isoTimestamp(this.now()));
      this.lastError = record;
      this.state = 'degraded';
      this.stopping = true;
      this.clearTimers();
      this.onFatal?.(error instanceof ArchiveError ? error : new ArchiveError('COLLECTION_LEASE_LOST', record.message));
    }
  }

  private clearTimers(): void {
    if (this.scanTimer) { clearTimeout(this.scanTimer); this.scanTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  /** Run one serialized scan. Concurrent callers cannot start a re-entrant scan. */
  scanOnce(): Promise<CollectionScanSummary> {
    if (this.currentScan) return Promise.reject(new ArchiveError('SCAN_BUSY', 'A collection scan is already running'));
    this.currentScan = this.runScan().finally(() => { this.currentScan = null; });
    return this.currentScan;
  }

  private async runScan(): Promise<CollectionScanSummary> {
    if (!this.config.collection.enabled) return emptySummary();
    const summary = emptySummary();
    const startedAt = isoTimestamp(this.now());
    this.lastScanStartedAt = startedAt;
    this.state = 'scanning';
    this.heartbeatAt = startedAt;
    try {
      for (const source of this.config.collection.sources) {
        if (this.stopping) break;
        if (this.leaseOwner) renewCollectionLease(this.archive.db, this.leaseOwner, this.leaseTtlMs, this.now());
        try {
          await this.scanSource(source, summary);
        } catch (error) {
          if (error instanceof ArchiveError && error.code === 'COLLECTION_LEASE_LOST') throw error;
          const record = errorRecord(error, isoTimestamp(this.now()));
          summary.errors++;
          this.lastError = record;
          this.recordSourceError(source, record);
        }
        // Let the HTTP listener and signal handlers run between files/sources.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      return summary;
    } finally {
      this.lastScan = { ...summary };
      this.lastScanFinishedAt = isoTimestamp(this.now());
      this.heartbeatAt = this.lastScanFinishedAt;
      if (summary.errors > 0) this.state = 'degraded';
      else if (!this.stopping) {
        this.lastError = null;
        this.state = 'idle';
      }
      this.onScan?.({ ...summary }, this.state);
    }
  }

  private async scanSource(source: SourceConfig, summary: CollectionScanSummary): Promise<void> {
    const key = sourceKey(source);
    const scopeHash = sourceScopeHash(source);
    let state = this.sourceStates.get(key) ?? { baselined: false, scope_hash: '', last_scan_at: null, last_error: null };
    let files: string[];
    files = sourceFiles([source.root]);
    if (files.length > MAX_SOURCE_FILES) throw new ArchiveError('TOO_MANY_SOURCES', `More than ${MAX_SOURCE_FILES} files selected in ${source.root}`);
    summary.files += files.length;
    const now = this.now();
    // Names are optional display metadata read beside this source only.
    const titles = titleLookup(readSessionTitles(source.root));

    // backfill=none: the first complete successful discovery only records a
    // baseline. Later new/changed files are imported. The baseline write is
    // atomic, so a partial discovery cannot silently promote existing files.
    if (this.config.collection.backfill === 'none' && !state.baselined) {
      const versions = files.map(file => this.fileVersion(file));
      this.writeBaseline(source, key, scopeHash, versions, now);
      state = { ...state, baselined: true, scope_hash: scopeHash, last_scan_at: isoTimestamp(now), last_error: null };
      this.sourceStates.set(key, state);
      this.updateSourceStatus(key, isoTimestamp(now), null);
      return;
    }

    const stored = this.loadFileStates(key);
    let sourceError: { code: string; message: string; at: string } | null = null;
    for (const [index, file] of files.entries()) {
      if (this.stopping) break;
      if (this.leaseOwner) renewCollectionLease(this.archive.db, this.leaseOwner, this.leaseTtlMs, this.now());
      try {
        const version = this.fileVersion(file);
        const previous = stored.get(version.file_id);
        const sameVersion = previous !== undefined
          && previous.size === version.size
          && previous.mtime_ms === version.mtime_ms
          && previous.ctime_ms === version.ctime_ms;
        if (sameVersion) {
          if (previous.outcome === 'unmatched' && previous.scope_hash !== scopeHash) {
            // Configuration now covers this file: fall through and re-read it.
          } else if (previous.outcome === 'baselined' && this.config.collection.backfill === 'all') {
            // An explicit switch from none to all imports previously baselined files once.
          } else {
            if (previous.outcome === 'unmatched') summary.unmatched_projects++;
            if (previous.pending) summary.pending++;
            continue;
          }
        }
        await this.importCandidate(source, key, scopeHash, version, summary, titles);
      } catch (error) {
        if (error instanceof ArchiveError && error.code === 'COLLECTION_LEASE_LOST') throw error;
        const record = errorRecord(error, isoTimestamp(this.now()));
        summary.errors++;
        sourceError = record;
        this.lastError = record;
        this.recordSourceError(source, record);
      }
      // Yield between files so one large source cannot starve the HTTP server.
      if (index % 8 === 7) await new Promise<void>(resolve => setImmediate(resolve));
    }

    const finishedAt = isoTimestamp(this.now());
    this.sourceStates.set(key, {
      baselined: true,
      scope_hash: scopeHash,
      last_scan_at: finishedAt,
      last_error: sourceError,
    });
    this.saveSourceRow(source, key, true, scopeHash, finishedAt, sourceError);
    this.updateSourceStatus(key, finishedAt, sourceError);
  }

  private fileVersion(file: string): FileVersion {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new ArchiveError('INVALID_SOURCE', 'Source must be a regular file, not a symlink');
    const fileId = `${stat.dev}:${stat.ino}`;
    return {
      file_id: fileId,
      path: file,
      size: stat.size,
      mtime_ms: Math.trunc(stat.mtimeMs),
      ctime_ms: Math.trunc(stat.ctimeMs),
    };
  }

  private loadFileStates(key: string): Map<string, FileState> {
    const states = new Map<string, FileState>();
    const rows = this.archive.db.prepare(`SELECT file_id,path,size,mtime_ms,ctime_ms,outcome,pending,scope_hash,updated_at
      FROM collection_files WHERE source_key=?`).all(key);
    for (const row of rows) {
      states.set(String(row.file_id), {
        file_id: String(row.file_id),
        path: String(row.path),
        size: Number(row.size),
        mtime_ms: Number(row.mtime_ms),
        ctime_ms: Number(row.ctime_ms),
        outcome: String(row.outcome) as FileOutcome,
        pending: Number(row.pending),
        scope_hash: String(row.scope_hash),
        updated_at: String(row.updated_at),
      });
    }
    return states;
  }

  private writeBaseline(source: SourceConfig, key: string, scopeHash: string, versions: FileVersion[], now: number): void {
    const at = isoTimestamp(now);
    this.archive.db.exec('BEGIN IMMEDIATE');
    try {
      for (const version of versions) {
        this.saveFileRow(key, version, 'baselined', false, scopeHash, at);
      }
      this.saveSourceRow(source, key, true, scopeHash, at, null);
      this.archive.db.exec('COMMIT');
    } catch (error) {
      try { this.archive.db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  private saveSourceRow(
    source: SourceConfig,
    key: string,
    baselined: boolean,
    scopeHash: string,
    lastScanAt: string,
    error: { code: string; message: string; at: string } | null,
  ): void {
    this.archive.db.prepare(`INSERT INTO collection_sources
      (source_key,instance_id,root,baselined,scope_hash,last_scan_at,last_error_code,last_error_message,last_error_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_key) DO UPDATE SET
        instance_id=excluded.instance_id, root=excluded.root, baselined=excluded.baselined,
        scope_hash=excluded.scope_hash, last_scan_at=excluded.last_scan_at,
        last_error_code=excluded.last_error_code, last_error_message=excluded.last_error_message,
        last_error_at=excluded.last_error_at`)
      .run(key, source.instance_id, source.root, baselined ? 1 : 0, scopeHash, lastScanAt,
        error?.code ?? null, error?.message ?? null, error?.at ?? null);
  }

  private recordSourceError(source: SourceConfig, error: { code: string; message: string; at: string }): void {
    const key = sourceKey(source);
    const state = this.sourceStates.get(key) ?? { baselined: false, scope_hash: '', last_scan_at: null, last_error: null };
    const next = { ...state, last_scan_at: error.at, last_error: error };
    this.sourceStates.set(key, next);
    this.saveSourceRow(source, key, next.baselined, sourceScopeHash(source), error.at, error);
    this.updateSourceStatus(key, error.at, error);
  }

  private saveFileRow(
    key: string,
    version: FileVersion,
    outcome: FileOutcome,
    pending: boolean,
    scopeHash: string,
    updatedAt: string,
  ): void {
    this.archive.db.prepare(`INSERT INTO collection_files
      (source_key,file_id,path,size,mtime_ms,ctime_ms,outcome,pending,scope_hash,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_key,file_id) DO UPDATE SET
        path=excluded.path, size=excluded.size, mtime_ms=excluded.mtime_ms, ctime_ms=excluded.ctime_ms,
        outcome=excluded.outcome, pending=excluded.pending, scope_hash=excluded.scope_hash, updated_at=excluded.updated_at`)
      .run(key, version.file_id, version.path, version.size, version.mtime_ms, version.ctime_ms,
        outcome, pending ? 1 : 0, scopeHash, updatedAt);
  }

  private updateSourceStatus(
    key: string,
    lastScanAt: string,
    error: { code: string; message: string; at: string } | null,
  ): void {
    const current = this.sourceStatuses.get(key);
    if (current) this.sourceStatuses.set(key, { ...current, last_scan_at: lastScanAt, last_error: error });
  }

  private async importCandidate(
    source: SourceConfig,
    key: string,
    scopeHash: string,
    version: FileVersion,
    summary: CollectionScanSummary,
    titles?: TitleLookup,
  ): Promise<void> {
    const resolve = (cwd: unknown): string => {
      const match = projectForCwd(source, cwd);
      if ('error' in match) throw new ArchiveError(match.error, match.message);
      return match.project_id;
    };
    try {
      const report = this.archive.importFile(version.path, source.instance_id, resolve, titles, source.runtime);
      summary.imported += report.imported;
      summary.skipped += report.skipped;
      if (report.pending) summary.pending++;
      this.saveFileRow(key, version, 'imported', report.pending, scopeHash, isoTimestamp(this.now()));
    } catch (error) {
      if (error instanceof ArchiveError && (error.code === 'PROJECT_UNMATCHED' || error.code === 'PROJECT_AMBIGUOUS')) {
        summary.unmatched_projects++;
        this.saveFileRow(key, version, 'unmatched', false, scopeHash, isoTimestamp(this.now()));
        return;
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    this.clearTimers();
    const running = this.currentScan;
    if (running) {
      try { await running; } catch { /* the scan already recorded/returned its failure */ }
    }
    if (this.leaseOwner) {
      try { releaseCollectionLease(this.archive.db, this.leaseOwner); } catch { /* stop must not throw during cleanup */ }
      this.leaseOwner = null;
    }
    this.state = 'stopped';
    this.heartbeatAt = isoTimestamp(this.now());
    this.started = false;
  }

  status(): CollectionStatus {
    const enabled = this.config.collection.enabled;
    return {
      enabled,
      state: enabled ? this.state : 'disabled',
      started_at: this.startedAt,
      heartbeat_at: this.heartbeatAt,
      scan_interval_seconds: enabled ? this.config.collection.scan_interval_seconds : null,
      last_scan_started_at: this.lastScanStartedAt,
      last_scan_finished_at: this.lastScanFinishedAt,
      last_scan: this.lastScan,
      last_error: this.lastError,
      sources: this.config.collection.sources.map(source => {
        const status = this.sourceStatuses.get(sourceKey(source));
        return status ?? {
          instance_id: source.instance_id,
          root: source.root,
          project_ids: source.projects.map(project => project.project_id),
          last_scan_at: null,
          last_error: null,
        };
      }),
    };
  }

  /** Non-secret state for startup logs/tests. */
  describe(): JsonObject {
    return {
      enabled: this.config.collection.enabled,
      state: this.state,
      lease_ttl_seconds: Math.floor(this.leaseTtlMs / 1000),
      sources: this.status().sources.length,
    };
  }
}
