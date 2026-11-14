/**
 * Optional display names for archived sessions.
 *
 * Codex keeps human session names beside the rollout roots: an append-only
 * `session_index.jsonl` and a versioned `state_*.sqlite` (`threads.name`).
 * Stats already reads both for direct imports; the archive reads the same
 * sources so a follow-based dashboard shows the same names. Names are optional
 * decoration: any read failure only means an unnamed session, never a lost
 * event or a failed scan.
 */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type TitleLookup = (sessionId: string) => string | null;

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name) return null;
  const chars = Array.from(name);
  return chars.length > 80 ? chars.slice(0, 79).join('') + '…' : name;
}

/**
 * Resolve the Codex home that owns a configured source root. Roots normally
 * point at `<home>/sessions` or `<home>/archived_sessions`; an exported
 * directory with a colocated index is used as-is.
 */
export function metadataHome(root: string): string {
  const resolved = path.resolve(root);
  let current = resolved;
  for (;;) {
    const base = path.basename(current);
    if (base === 'sessions' || base === 'archived_sessions') return path.dirname(current);
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    current = parent;
  }
}

function readIndex(home: string, titles: Map<string, string>): void {
  const filename = path.join(home, 'session_index.jsonl');
  let text: string;
  try {
    if (!lstatSync(filename).isFile()) return;
    text = readFileSync(filename, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as unknown;
      if (typeof row !== 'object' || row === null) continue;
      const value = row as { id?: unknown; thread_name?: unknown };
      const name = cleanName(value.thread_name);
      if (typeof value.id === 'string' && value.id && name) titles.set(value.id, name);
    } catch {
      // A damaged index line must not hide the rest of the names.
    }
  }
}

function stateDatabases(home: string): string[] {
  try {
    return readdirSync(home)
      .map(name => ({ name, match: /^state_(\d+)\.sqlite$/.exec(name) }))
      .filter(entry => entry.match)
      .sort((a, b) => Number(b.match![1]) - Number(a.match![1]))
      .map(entry => path.join(home, entry.name));
  } catch {
    return [];
  }
}

function readThreads(filename: string, titles: Map<string, string>): boolean {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(filename, { readOnly: true });
    db.exec('PRAGMA busy_timeout=1000');
    const columns = new Set((db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>)
      .map(row => String(row.name)));
    if (!columns.has('id') || !columns.has('name')) return false;
    for (const row of db.prepare('SELECT id,name FROM threads').all() as Array<{ id: unknown; name: unknown }>) {
      const name = cleanName(row.name);
      if (typeof row.id === 'string' && row.id && name) titles.set(row.id, name);
    }
    return true;
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch { /* read-only handle */ }
  }
}

/**
 * Read display names for one source root. The newest readable state database
 * wins over the append-only index, mirroring the direct-import path. Returns an
 * empty map when the source has no readable metadata.
 */
export function readSessionTitles(root: string): Map<string, string> {
  const titles = new Map<string, string>();
  const home = metadataHome(root);
  readIndex(home, titles);
  for (const filename of stateDatabases(home)) if (readThreads(filename, titles)) break;
  return titles;
}

export function titleLookup(titles: Map<string, string>): TitleLookup {
  return sessionId => titles.get(sessionId) ?? null;
}
