import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NORMALIZER_VERSION, normalize, parseRecords } from './codex.ts';
import { ArchiveError, cursorOf, hash, identifier, viewOf, type Batch, type Event, type View } from './types.ts';

const MAX_FILE_BYTES = 128 * 1024 * 1024;
export class Archive {
  db: DatabaseSync;
  archiveId: string;
  captureMode: View;
  constructor(filename: string, captureMode?: View) {
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

  importFile(filename: string, instanceId: string, projectId: string): { imported: number; skipped: number; pending: boolean } {
    identifier(instanceId, 'instance ID'); identifier(projectId, 'project ID');
    const absolutePath = path.resolve(filename);
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ArchiveError('INVALID_SOURCE', 'Source must be a regular file, not a symlink');
    if (stat.size > MAX_FILE_BYTES) throw new ArchiveError('FILE_TOO_LARGE', 'Source exceeds 128 MiB');
    // Bound the read even if the source grows between stat and read.
    const buffer = readFileSync(absolutePath);
    if (buffer.length > MAX_FILE_BYTES) throw new ArchiveError('FILE_TOO_LARGE', 'Source exceeds 128 MiB');
    const input = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    const { records, pending } = parseRecords(input);
    if (!records.length) return { imported: 0, skipped: 0, pending };
    const events = normalize(records, absolutePath, instanceId, projectId, this.captureMode);
    const first = events[0]!;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const session = this.db.prepare('SELECT project_id,deleted FROM sessions WHERE session_key=?').get(first.session_key);
      if (session?.deleted) throw new ArchiveError('SESSION_DELETED', 'Deleted session cannot be silently reimported');
      if (session && session.project_id !== projectId) throw new ArchiveError('SOURCE_CONFLICT', 'Existing session belongs to another project');
      this.db.prepare('INSERT OR IGNORE INTO sessions(session_key,runtime,instance_id,session_id,project_id) VALUES(?,?,?,?,?)')
        .run(first.session_key, first.runtime, instanceId, first.session_id, projectId);
      let imported = 0;
      let skipped = 0;
      const find = this.db.prepare('SELECT record_hash FROM events WHERE event_id=?');
      const add = this.db.prepare('INSERT INTO events(event_id,session_key,record_hash,payload) VALUES(?,?,?,?)');
      for (const event of events) {
        const recordHash = event.source!.record_hash;
        const existing = find.get(event.event_id);
        if (existing) {
          if (existing.record_hash !== recordHash) throw new ArchiveError('SOURCE_CONFLICT', 'Existing source record changed; no events from this file were imported');
          skipped++;
        } else {
          add.run(event.event_id, event.session_key, recordHash, JSON.stringify(event)); imported++;
        }
      }
      this.db.exec('COMMIT');
      return { imported, skipped, pending };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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
      this.db.prepare('DELETE FROM events WHERE session_key=?').run(key);
      this.db.prepare('UPDATE sessions SET deleted=1 WHERE session_key=?').run(key);
      const now = new Date().toISOString();
      const event: Event = {
        schema_version: 1, event_id: hash(JSON.stringify([runtime, instanceId, sessionId, 'deleted'])), archive_seq: 0,
        runtime, instance_id: instanceId, session_id: sessionId, session_key: key, project_id: String(session.project_id),
        kind: 'session.deleted', occurred_at: now, observed_at: now, native_type: 'archive.session_deleted', source: null, data: {}, body: null, raw: null,
      };
      this.db.prepare('INSERT INTO events(event_id,session_key,record_hash,payload) VALUES(?,?,?,?)').run(event.event_id, key, hash('deleted'), JSON.stringify(event));
      this.db.exec('COMMIT'); return { deleted: true, event_id: event.event_id };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  status(): object {
    return {
      schema_version: 1, archive_id: this.archiveId, capture_mode: this.captureMode,
      high_watermark: this.highWatermark(),
      events: this.db.prepare('SELECT count(*) AS n FROM events').get()!.n,
      sessions: this.db.prepare('SELECT count(*) AS n FROM sessions WHERE deleted=0').get()!.n,
      deleted_sessions: this.db.prepare('SELECT count(*) AS n FROM sessions WHERE deleted=1').get()!.n,
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
