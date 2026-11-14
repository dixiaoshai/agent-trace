import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { metadataHome, readSessionTitles } from '../src/titles.ts';

function temporary(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-trace-titles-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function stateDatabase(filename: string, rows: Array<[string, string]>): void {
  const db = new DatabaseSync(filename);
  try {
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT)');
    const insert = db.prepare('INSERT INTO threads (id,name) VALUES (?,?)');
    for (const [id, name] of rows) insert.run(id, name);
  } finally {
    db.close();
  }
}

test('metadataHome resolves Codex source roots and colocated export roots', t => {
  assert.equal(metadataHome('/home/u/.codex/sessions'), '/home/u/.codex');
  assert.equal(metadataHome('/home/u/.codex/archived_sessions'), '/home/u/.codex');
  assert.equal(metadataHome('/home/u/.codex/sessions/2026/01'), '/home/u/.codex');
  assert.equal(metadataHome('/home/u/exported'), '/home/u/exported');
});

test('titles merge the append-only index with the newest readable state database', t => {
  const home = temporary(t);
  const sessions = path.join(home, 'sessions');
  mkdirSync(sessions);
  writeFileSync(path.join(home, 'session_index.jsonl'), [
    JSON.stringify({ id: 'index-only', thread_name: 'Index name' }),
    JSON.stringify({ id: 'renamed', thread_name: 'Old name' }),
    JSON.stringify({ id: 'renamed', thread_name: 'New name' }),
    JSON.stringify({ id: 'blank', thread_name: '   ' }),
    '{not json',
  ].join('\n'));
  stateDatabase(path.join(home, 'state_2.sqlite'), [
    ['renamed', 'Database name'],
    ['db-only', '  Spaced  name  '],
    ['bad', ''],
  ]);
  stateDatabase(path.join(home, 'state_1.sqlite'), [['renamed', 'Stale name']]);

  const titles = readSessionTitles(sessions);
  assert.equal(titles.get('index-only'), 'Index name');
  assert.equal(titles.get('renamed'), 'Database name');
  assert.equal(titles.get('db-only'), 'Spaced  name');
  assert.equal(titles.has('blank'), false);
  assert.equal(titles.has('bad'), false);
});

test('an unusable newest state database falls back to the index and older schema', t => {
  const home = temporary(t);
  const sessions = path.join(home, 'sessions');
  mkdirSync(sessions);
  writeFileSync(path.join(home, 'session_index.jsonl'),
    JSON.stringify({ id: 'renamed', thread_name: 'Index name' }) + '\n');
  // Newest file is not a database; the next schema is read, then the index wins
  // only where the database has no row.
  writeFileSync(path.join(home, 'state_9.sqlite'), 'not a database');
  stateDatabase(path.join(home, 'state_3.sqlite'), [['db-only', 'From schema 3']]);

  const titles = readSessionTitles(sessions);
  assert.equal(titles.get('renamed'), 'Index name');
  assert.equal(titles.get('db-only'), 'From schema 3');
});

test('bounded titles are single line and at most 80 characters', t => {
  const home = temporary(t);
  const sessions = path.join(home, 'sessions');
  mkdirSync(sessions);
  const long = 'x'.repeat(120);
  writeFileSync(path.join(home, 'session_index.jsonl'),
    JSON.stringify({ id: 'long', thread_name: long }) + '\n');
  const titles = readSessionTitles(sessions);
  assert.equal(Array.from(titles.get('long')!).length, 80);
  assert.ok(titles.get('long')!.endsWith('…'));
});

test('sources without readable metadata simply yield no names', t => {
  const home = temporary(t);
  assert.deepEqual([...readSessionTitles(path.join(home, 'sessions'))], []);
  mkdirSync(path.join(home, 'sessions'));
  assert.deepEqual([...readSessionTitles(path.join(home, 'sessions'))], []);
});
