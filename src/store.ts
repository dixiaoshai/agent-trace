import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NORMALIZER_VERSION, normalize, parseRecords, sessionCwd as codexSessionCwd } from './codex.ts';
import {
  contentPolicy, protectEvent, referencedBlobs, removeBlobs, type ContentOptions, type ContentPolicy,
} from './content.ts';
import {
  detectRuntime, normalize as normalizePi, parseRecords as parsePiRecords, sessionCwd as piSessionCwd,
} from './pi.ts';
import type { TitleLookup } from './titles.ts';
import {
  ArchiveError, cursorOf, hash, identifier, timestamp, viewOf,
  type ArchiveStatus, type Batch, type Event, type RuntimeHint, type View,
} from './types.ts';

const MAX_FILE_BYTES = 128 * 1024 * 1024;

export interface BlobPruneResult {
  directory: string;
  files: number;
  referenced: number;
  orphans: number;
  removed: number;
  dry_run: boolean;
}

/**
 * The CLI passes a fixed project. The scanner passes a resolver so the project
 * is selected from the session metadata inside the same parsed snapshot that is
 * about to be archived; the file is never read twice for identity/matching.
 */
export type ProjectSelector = string | ((cwd: unknown) => string);
export class Archive {
  db: DatabaseSync;
  archiveId: string;
  captureMode: View;
  readonly content: ContentPolicy;
  constructor(filename: string, captureMode?: View, contentOptions: ContentOptions = {}) {
    this.content = contentPolicy(filename, contentOptions);
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    try {
      if (filename !== ':memory:') chmodSync(filename, 0o600);
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      const version = this.db.prepare('PRAGMA user_version').get()!;
      if (version.user_version !== 0 && version.user_version !== 1) throw new ArchiveError('SCHEMA_VERSION', 'Unsupported archive database schema');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (
          session_key TEXT PRIMARY KEY, runtime TEXT NOT NULL, instance_id TEXT NOT NULL,
          session_id TEXT NOT NULL, project_id TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
          session_key TEXT NOT NULL REFERENCES sessions(session_key), record_hash TEXT NOT NULL, payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_session ON events(session_key);
        CREATE TABLE IF NOT EXISTS session_revisions (
          session_key TEXT PRIMARY KEY, revision_at TEXT NOT NULL, event_count INTEGER NOT NULL,
          source_path TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        PRAGMA user_version=1;
      `);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const insert = this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)');
        insert.run('archive_id', randomUUID());
        insert.run('capture_mode', captureMode ?? 'metadata');
        insert.run('normalizer_version', NORMALIZER_VERSION);
        this.archiveId = String(this.db.prepare('SELECT value FROM metadata WHERE key=?').get('archive_id')!.value);
        this.captureMode = viewOf(this.db.prepare('SELECT value FROM metadata WHERE key=?').get('capture_mode')!.value);
        if (captureMode && this.captureMode !== captureMode) throw new ArchiveError('CAPTURE_MODE', 'Archive capture mode is fixed; use a separate database to change it');
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }

  importFile(
    filename: string,
    instanceId: string,
    project: ProjectSelector,
    titles?: TitleLookup,
    runtimeHint: RuntimeHint = 'auto',
  ): { imported: number; skipped: number; pending: boolean } {
    identifier(instanceId, 'instance ID');
    if (typeof project === 'string') identifier(project, 'project ID');
    const absolutePath = path.resolve(filename);
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ArchiveError('INVALID_SOURCE', 'Source must be a regular file, not a symlink');
    if (stat.size > MAX_FILE_BYTES) throw new ArchiveError('FILE_TOO_LARGE', 'Source exceeds 128 MiB');
    // Bound the read even if the source grows between stat and read.
    const buffer = readFileSync(absolutePath);
    if (buffer.length > MAX_FILE_BYTES) throw new ArchiveError('FILE_TOO_LARGE', 'Source exceeds 128 MiB');
    const input = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    // Empty selected files stay a no-op rather than a runtime-detection error.
    if (!input.trim()) return { imported: 0, skipped: 0, pending: false };
    const detected = detectRuntime(input);
    if (runtimeHint !== 'auto' && runtimeHint !== detected) {
      throw new ArchiveError('RUNTIME_MISMATCH', `Source is a ${detected} session, but ${runtimeHint} was selected`);
    }
    const runtime = detected;
    const { records, pending } = runtime === 'pi' ? parsePiRecords(input) : parseRecords(input);
    if (!records.length) return { imported: 0, skipped: 0, pending };
    let projectId: string;
    if (typeof project === 'function') {
      // Missing session identity is a malformed source, not a project mismatch;
      // keep it retryable as an error instead of silently baselining it. The
      // Codex helper reads the final resume/subagent identity, matching
      // normalize(); the pi helper reads the session header.
      const cwd = runtime === 'pi' ? piSessionCwd(records) : codexSessionCwd(records);
      projectId = project(cwd);
      identifier(projectId, 'project ID');
    } else projectId = project;
    const normalized = runtime === 'pi'
      ? normalizePi(records, absolutePath, instanceId, projectId, this.captureMode)
      : normalize(records, absolutePath, instanceId, projectId, this.captureMode, titles);
    // Content protection runs before the archive transaction: a blob write
    // failure aborts the import instead of committing an unprotected event.
    // Every written path is tracked so a discarded revision (older rollout,
    // deleted session, conflict, storage or SQL error) cannot leave files that
    // no committed event references.
    const written: string[] = [];
    let events: Event[];
    try {
      events = this.captureMode === 'content'
        ? normalized.map(event => {
            const protectedEvent = protectEvent(event, this.content);
            written.push(...referencedBlobs(JSON.stringify(protectedEvent)));
            return protectedEvent;
          })
        : normalized;
    } catch (error) {
      this.removeUnreferencedBlobs(written);
      throw error;
    }
    const first = events[0]!;
    // A rollout can be rewritten in place, and Codex can leave several files
    // for one session identity (resumed or subagent rollouts). Like the direct
    // importer, keep the newest revision: the greatest last event timestamp,
    // then the greatest row count. Older or identical revisions are skipped, so
    // copies stay idempotent and cumulative usage is never merged across
    // revisions.
    const revisionAt = records.reduce((max, record) => {
      const stamp = timestamp(record.row.timestamp) ?? '';
      return stamp > max ? stamp : max;
    }, '');
    const rank = { revision_at: revisionAt, event_count: records.length };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const session = this.db.prepare('SELECT project_id,deleted FROM sessions WHERE session_key=?').get(first.session_key);
      if (session?.deleted) throw new ArchiveError('SESSION_DELETED', 'Deleted session cannot be silently reimported');
      if (session && session.project_id !== projectId) throw new ArchiveError('SOURCE_CONFLICT', 'Existing session belongs to another project');
      const stored = this.db.prepare('SELECT revision_at,event_count FROM session_revisions WHERE session_key=?')
        .get(first.session_key);
      const current = stored
        ? { revision_at: String(stored.revision_at), event_count: Number(stored.event_count) }
        : null;
      // Equal revisions are reconciled (an in-place rewrite replaces changed
      // lines and leaves identical ones untouched); older revisions are ignored.
      const apply = !current
        || rank.revision_at > current.revision_at
        || (rank.revision_at === current.revision_at && rank.event_count >= current.event_count);
      if (!apply) {
        // The revision is older than what is stored: drop the files this
        // attempt just wrote instead of keeping unreachable content.
        this.removeUnreferencedBlobs(written);
        this.db.exec('COMMIT');
        return { imported: 0, skipped: events.length, pending };
      }
      this.db.prepare('INSERT OR IGNORE INTO sessions(session_key,runtime,instance_id,session_id,project_id) VALUES(?,?,?,?,?)')
        .run(first.session_key, first.runtime, instanceId, first.session_id, projectId);
      const existing = new Map(
        this.db.prepare('SELECT event_id,record_hash,payload FROM events WHERE session_key=?').all(first.session_key)
          .map(row => [String(row.event_id), { record_hash: String(row.record_hash), payload: String(row.payload) }]),
      );
      const incoming = new Map(events.map(event => [event.event_id, event]));
      const remove = this.db.prepare('DELETE FROM events WHERE event_id=?');
      const add = this.db.prepare('INSERT INTO events(event_id,session_key,record_hash,payload) VALUES(?,?,?,?)');
      let imported = 0;
      let skipped = 0;
      const removedBlobs: string[] = [];
      // A different winning rollout replaces the previous revision entirely;
      // otherwise unchanged lines keep their identity and sequence position.
      for (const [eventId, prior] of existing) {
        const next = incoming.get(eventId);
        if (!next || next.source!.record_hash !== prior.record_hash) {
          remove.run(eventId);
          removedBlobs.push(...referencedBlobs(prior.payload));
        }
      }
      for (const event of events) {
        const prior = existing.get(event.event_id);
        if (prior !== undefined && prior.record_hash === event.source!.record_hash) { skipped++; continue; }
        add.run(event.event_id, event.session_key, event.source!.record_hash, JSON.stringify(event));
        imported++;
      }
      this.db.prepare(`INSERT INTO session_revisions(session_key,revision_at,event_count,source_path,updated_at)
        VALUES(?,?,?,?,?)
        ON CONFLICT(session_key) DO UPDATE SET revision_at=excluded.revision_at, event_count=excluded.event_count,
          source_path=excluded.source_path, updated_at=excluded.updated_at`)
        .run(first.session_key, rank.revision_at, rank.event_count, absolutePath, new Date().toISOString());
      this.db.exec('COMMIT');
      // A reconciled rewrite can reuse a blob path for identical redacted
      // content; never delete a file the just-committed events still cite.
      const kept = new Set(events.flatMap(event => referencedBlobs(JSON.stringify(event))));
      removeBlobs(removedBlobs.filter(blob => !kept.has(blob)), this.content);
      return { imported, skipped, pending };
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.removeUnreferencedBlobs(written);
      throw error;
    }
  }

  /**
   * Delete files written by an import attempt that was not committed (or was
   * superseded), skipping any path a committed event already cites.
   */
  private removeUnreferencedBlobs(candidates: string[]): void {
    if (this.captureMode !== 'content' || !candidates.length) return;
    const cited = this.db.prepare('SELECT 1 FROM events WHERE instr(payload, ?) > 0 LIMIT 1');
    const orphans = [...new Set(candidates)].filter(candidate => !cited.get(candidate));
    removeBlobs(orphans, this.content);
  }

  /**
   * Remove blob files that no committed event cites. Only files directly inside
   * the configured directory whose name is `<event_id>-<sha256>.txt` are
   * candidates, so a wrong path cannot delete unrelated user files.
   */
  pruneOrphanBlobs(options: { dry_run?: boolean } = {}): BlobPruneResult {
    if (this.captureMode !== 'content') {
      throw new ArchiveError('CAPTURE_MODE', 'Blob pruning requires a content archive');
    }
    const directory = path.resolve(this.content.blob_directory);
    const referenced = new Set<string>();
    const rows = this.db.prepare('SELECT payload FROM events').iterate();
    try {
      for (const row of rows) {
        for (const blob of referencedBlobs(String(row.payload))) referenced.add(path.resolve(blob));
      }
    } finally { rows.return?.(); }
    let names: string[] = [];
    try { names = readdirSync(directory); } catch { names = []; }
    const pattern = /^[0-9a-f]{64}-[0-9a-f]{64}\.txt$/;
    let files = 0, orphans = 0, removed = 0;
    for (const name of names) {
      if (!pattern.test(name)) continue;
      files++;
      const full = path.join(directory, name);
      if (referenced.has(full)) continue;
      orphans++;
      if (options.dry_run) continue;
      try { rmSync(full); removed++; } catch { /* already gone or not removable */ }
    }
    return { directory, files, referenced: files - orphans, orphans, removed, dry_run: options.dry_run === true };
  }

  /** Highest committed archive sequence. Deletions leave legitimate gaps, so this is not an unread-event count. */
  highWatermark(): number {
    return Number(this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get()?.seq ?? 0);
  }
  exportBatch(after = 0, limit = 500, view: View = 'metadata'): Batch {
    cursorOf(after); viewOf(view);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new ArchiveError('INVALID_INPUT', 'limit must be 1..10000');
    this.db.exec('BEGIN');
    try {
      const high = this.highWatermark();
      if (after > high) throw new ArchiveError('INVALID_CURSOR', 'Cursor is beyond archive history');
      const rows = this.db.prepare('SELECT seq,payload FROM events WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?').all(after, high, limit + 1);
      const hasMore = rows.length > limit;
      const selected = rows.slice(0, limit);
      const events = selected.map(row => this.present(String(row.payload), Number(row.seq), view));
      const next = hasMore ? events.at(-1)!.archive_seq : high;
      this.db.exec('COMMIT');
      return { schema_version: 1, archive_id: this.archiveId, view, after_cursor: after, next_cursor: next, has_more: hasMore, events };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private present(payload: string, seq: number, view: View): Event {
    const event = JSON.parse(payload) as Event;
    return { ...event, archive_seq: seq, body: view === 'content' ? event.body : null, raw: view === 'content' ? event.raw : null };
  }
  readEvent(eventId: string, view: View = 'metadata'): Event | null {
    identifier(eventId, 'event ID'); viewOf(view);
    const row = this.db.prepare('SELECT seq,payload FROM events WHERE event_id=?').get(eventId);
    return row ? this.present(String(row.payload), Number(row.seq), view) : null;
  }
  deleteSession(runtime: string, instanceId: string, sessionId: string): { deleted: boolean; event_id?: string } {
    for (const [value, label] of [[runtime, 'runtime'], [instanceId, 'instance ID'], [sessionId, 'session ID']]) identifier(value, label!);
    const key = JSON.stringify([runtime, instanceId, sessionId]);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const session = this.db.prepare('SELECT * FROM sessions WHERE session_key=?').get(key);
      if (!session || session.deleted) { this.db.exec('COMMIT'); return { deleted: false }; }
      const payloads = this.db.prepare('SELECT payload FROM events WHERE session_key=?').all(key)
        .map(row => String(row.payload));
      this.db.prepare('DELETE FROM events WHERE session_key=?').run(key);
      this.db.prepare('UPDATE sessions SET deleted=1 WHERE session_key=?').run(key);
      const now = new Date().toISOString();
      const event: Event = {
        schema_version: 1, event_id: hash(JSON.stringify([runtime, instanceId, sessionId, 'deleted'])), archive_seq: 0,
        runtime, instance_id: instanceId, session_id: sessionId, session_key: key, project_id: String(session.project_id),
        kind: 'session.deleted', occurred_at: now, observed_at: now, native_type: 'archive.session_deleted', source: null, data: {}, body: null, raw: null,
      };
      this.db.prepare('INSERT INTO events(event_id,session_key,record_hash,payload) VALUES(?,?,?,?)').run(event.event_id, key, hash('deleted'), JSON.stringify(event));
      this.db.exec('COMMIT');
      // Erasure includes content-mode blobs; the paths are constrained to the
      // configured directory by removeBlobs().
      if (this.captureMode === 'content') removeBlobs(payloads.flatMap(referencedBlobs), this.content);
      return { deleted: true, event_id: event.event_id };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  status(): ArchiveStatus {
    return {
      schema_version: 1, archive_id: this.archiveId, capture_mode: this.captureMode,
      high_watermark: this.highWatermark(),
      events: Number(this.db.prepare('SELECT count(*) AS n FROM events').get()!.n),
      sessions: Number(this.db.prepare('SELECT count(*) AS n FROM sessions WHERE deleted=0').get()!.n),
      deleted_sessions: Number(this.db.prepare('SELECT count(*) AS n FROM sessions WHERE deleted=1').get()!.n),
    };
  }
}

/** Only explicitly selected roots are scanned; links are never followed. */
export function sourceFiles(roots: string[]): string[] {
  const files = new Set<string>();
  function visit(name: string): void {
    const stat = lstatSync(name);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) { if (name.endsWith('.jsonl')) files.add(name); }
    else if (stat.isDirectory()) for (const entry of readdirSync(name).sort()) visit(path.join(name, entry));
    if (files.size > 10000) throw new ArchiveError('TOO_MANY_SOURCES', 'More than 10000 files selected');
  }
  roots.forEach(root => visit(path.resolve(root)));
  return [...files].sort();
}
