import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Archive, sourceFiles } from '../src/store.ts';
import { hash } from '../src/types.ts';

const fixture = path.resolve('fixtures/codex/demo.jsonl');
function setup(t: test.TestContext, capture: 'metadata' | 'content' = 'content') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-trace-test-'));
  const filename = path.join(dir, 'session.jsonl');
  copyFileSync(fixture, filename);
  const db = path.join(dir, 'archive.sqlite');
  const archive = new Archive(db, capture);
  t.after(() => { archive.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, filename, db, archive };
}

test('content archive preserves evidence, metadata projection excludes private bodies, moved copies deduplicate', t => {
  const { dir, filename, db, archive } = setup(t);
  assert.equal(archive.status().high_watermark, 0);
  const imported = archive.importFile(filename, 'test-device', 'demo');
  assert.equal(imported.imported, 11);
  assert.equal(archive.status().high_watermark, 11);
  const body = archive.exportBatch(0, 100, 'content');
  const metadata = archive.exportBatch();
  assert.equal(body.events.length, 11);
  assert.equal(metadata.events.length, 11);
  assert.match(JSON.stringify(body), /SYNTHETIC_PRIVATE_ARGUMENT/);
  assert.doesNotMatch(JSON.stringify(metadata), /SYNTHETIC_PRIVATE|SYNTHETIC_FUTURE/);
  assert.ok(metadata.events.every(e => e.body === null && e.raw === null));
  assert.equal(body.events.find(e => e.kind === 'tool.returned')!.data.status, 'result_observed');
  const future = body.events.find(e => e.kind === 'source.unknown')!;
  assert.match(JSON.stringify(future.raw), /SYNTHETIC_FUTURE_PAYLOAD/);
  const moved = path.join(dir, 'archived-copy.jsonl'); copyFileSync(filename, moved);
  assert.equal(archive.importFile(moved, 'test-device', 'demo').imported, 0);
  unlinkSync(filename); unlinkSync(moved);
  const record = archive.readEvent(future.event_id, 'content')!;
  assert.equal(record.source!.record_hash, hash(readFileSync(fixture, 'utf8').trim().split('\n').at(-1)!));
  assert.ok(record.raw);
  assert.equal(statSync(db).mode & 0o777, 0o600);
});

test('metadata capture does not persist content and mode cannot change silently', t => {
  const { filename, db, archive } = setup(t, 'metadata');
  archive.importFile(filename, 'local', 'demo');
  assert.ok(archive.exportBatch(0, 100, 'content').events.every(e => e.body === null && e.raw === null));
  assert.doesNotMatch(readFileSync(db).toString(), /SYNTHETIC_PRIVATE|SYNTHETIC_FUTURE/);
  assert.throws(() => new Archive(db, 'content'), /capture mode is fixed/);
});

test('partial tail waits for completion and keeps original identity', t => {
  const { filename, archive } = setup(t);
  const full = readFileSync(filename, 'utf8');
  const boundary = full.lastIndexOf('\n', full.length - 2) + 1;
  writeFileSync(filename, full.slice(0, boundary + 15));
  const one = archive.importFile(filename, 'local', 'demo');
  assert.equal(one.pending, true); assert.equal(one.imported, 10);
  writeFileSync(filename, full);
  const two = archive.importFile(filename, 'local', 'demo');
  assert.equal(two.imported, 1); assert.equal(two.skipped, 10);
});

test('malformed complete lines and conflicting source rewrites are atomic', t => {
  const { filename, archive } = setup(t);
  const full = readFileSync(filename, 'utf8');
  writeFileSync(filename, full + '{broken}\n');
  assert.throws(() => archive.importFile(filename, 'local', 'demo'), /Malformed complete/);
  assert.equal(archive.exportBatch().events.length, 0);
  writeFileSync(filename, full);
  archive.importFile(filename, 'local', 'demo');
  writeFileSync(filename, full.replace('task_complete', 'turn_aborted') + '{"type":"future","payload":{}}\n');
  assert.throws(() => archive.importFile(filename, 'local', 'demo'), /Existing source record changed/);
  assert.equal(archive.exportBatch().events.length, 11);
  assert.throws(() => archive.importFile(fixture, 'local', 'other-project'), /another project/);
});

test('pagination, durable cursor, independent archive identities and deletion feed', t => {
  const { filename, archive } = setup(t);
  archive.importFile(filename, 'local', 'demo');
  const first = archive.exportBatch(0, 3);
  const second = archive.exportBatch(first.next_cursor, 100, 'content');
  assert.equal(first.next_cursor, 3); assert.equal(first.has_more, true);
  assert.equal(second.next_cursor, 11); assert.equal(second.events.length, 8);
  const evidence = second.events[0]!.event_id;
  assert.equal(archive.deleteSession('codex', 'local', 'archive-demo-session').deleted, true);
  const deleted = archive.exportBatch(second.next_cursor);
  assert.equal(deleted.events.length, 1); assert.equal(deleted.events[0]!.kind, 'session.deleted');
  assert.equal(archive.highWatermark(), 12); assert.equal(archive.status().high_watermark, 12);
  assert.equal(deleted.events[0]!.source, null);
  assert.equal(archive.readEvent(evidence, 'content'), null);
  assert.equal(archive.exportBatch(0).events.length, 1);
  assert.equal(archive.deleteSession('codex', 'local', 'archive-demo-session').deleted, false);
  assert.throws(() => archive.importFile(filename, 'local', 'demo'), /Deleted session/);
  assert.throws(() => archive.exportBatch(100), /beyond archive history/);
  const other = new Archive(':memory:');
  try { assert.notEqual(other.archiveId, archive.archiveId); } finally { other.close(); }
});

test('selected root discovery skips symlinks and includes archived directory layouts', t => {
  const { dir, filename } = setup(t);
  symlinkSync(filename, path.join(dir, 'shortcut.jsonl'));
  assert.deepEqual(sourceFiles([dir, filename]), [filename]);
});

test('CLI uses explicit sources, exports private files without overwriting, supports source-free reads', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-trace-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = path.resolve('src/cli.ts');
  const db = path.join(dir, 'archive.sqlite');
  const run = (args: string[]) => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--db', db], { encoding: 'utf8' }));
  assert.throws(() => run(['ingest', '--instance', 'local', '--project', 'demo']));
  assert.equal(run(['ingest', '--source', fixture, '--instance', 'local', '--project', 'demo', '--capture', 'content']).imported, 11);
  const output = path.join(dir, 'batch.json');
  execFileSync(process.execPath, [cli, 'export', '--db', db, '--view', 'content', '--output', output]);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  const page = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(run(['read', '--event', page.events[3].event_id, '--view', 'content']).event.kind, 'message.user');
  assert.throws(() => run(['export', '--output', output]));
  assert.equal(run(['status']).capture_mode, 'content');
});

test('default database keeps legacy data accessible and explicit db overrides both defaults', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-trace-names-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = path.resolve('src/cli.ts');
  const run = (args: string[]) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' }));
  const legacyPath = path.join(dir, '.agent-archive', 'archive.sqlite');
  const canonicalPath = path.join(dir, '.agent-trace', 'trace.sqlite');
  const legacy = new Archive(legacyPath);
  const legacyId = legacy.archiveId;
  legacy.close();
  assert.equal(run(['status']).archive_id, legacyId);
  assert.equal(existsSync(canonicalPath), false);
  const canonical = new Archive(canonicalPath);
  const canonicalId = canonical.archiveId;
  canonical.close();
  assert.equal(run(['status']).archive_id, canonicalId);
  const explicitPath = path.join(dir, 'explicit.sqlite');
  const explicit = run(['status', '--db', explicitPath]);
  assert.notEqual(explicit.archive_id, legacyId);
  assert.notEqual(explicit.archive_id, canonicalId);
  assert.equal(run(['status', '--db', legacyPath]).archive_id, legacyId);
});

test('resumed and subagent rollouts archive under their final identity', t => {
  const { dir, archive } = setup(t);
  const filename = path.join(dir, 'resumed.jsonl');
  const rows = [
    { timestamp: '2026-02-01T00:00:00Z', type: 'session_meta', payload: { id: 'first-identity', cwd: '/synthetic/first' } },
    { timestamp: '2026-02-01T00:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp: '2026-02-01T00:00:02Z', type: 'session_meta', payload: { id: 'final-identity', cwd: '/synthetic/final' } },
    { timestamp: '2026-02-01T00:00:03Z', type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-6.1-sol' } },
    { timestamp: '2026-02-01T00:00:04Z', type: 'event_msg', payload: { type: 'token_count', turn_id: 'turn-1', info: { total_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } } },
    { timestamp: '2026-02-01T00:00:05Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ];
  writeFileSync(filename, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const seen: unknown[] = [];
  const project = (cwd: unknown): string => { seen.push(cwd); return 'final-project'; };
  const imported = archive.importFile(filename, 'local', project);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], '/synthetic/final');
  const batch = archive.exportBatch(0, 100, 'metadata');
  const starts = batch.events.filter(event => event.kind === 'session.started');
  assert.equal(starts.length, 1);
  assert.equal(starts[0]!.session_id, 'final-identity');
  assert.equal(starts[0]!.project_id, 'final-project');
  assert.equal(imported.imported, rows.length - 1);
  assert.ok(batch.events.every(event => event.session_id === 'final-identity'));
  // Re-reading the same file is stable: earlier identity markers are not events.
  assert.equal(archive.importFile(filename, 'local', project).imported, 0);
});

test('session names decorate the archived start event without changing bytes', t => {
  const { dir, archive } = setup(t);
  archive.importFile(fixture, 'local', 'demo', id => id === 'archive-demo-session' ? '  Synthetic   session  ' : null);
  const events = archive.exportBatch(0, 100, 'metadata').events;
  const start = events.find(event => event.kind === 'session.started')!;
  assert.equal(start.data.title, 'Synthetic session');
  assert.equal(start.body, null);
  assert.ok(events.every(event => event.body === null && event.raw === null));

  const unnamed = path.join(dir, 'unnamed.jsonl');
  writeFileSync(unnamed, JSON.stringify({
    timestamp: '2026-02-02T00:00:00Z',
    type: 'session_meta',
    payload: { id: 'unnamed-session', cwd: '/synthetic/demo' },
  }) + '\n');
  archive.importFile(unnamed, 'local', 'demo', () => null);
  const second = archive.exportBatch(0, 200, 'metadata').events
    .find(event => event.session_id === 'unnamed-session' && event.kind === 'session.started')!;
  assert.equal(second.data.title, null);
});

test('overlong session names are bounded before they reach consumers', t => {
  const { dir, archive } = setup(t);
  const filename = path.join(dir, 'long-name.jsonl');
  copyFileSync(fixture, filename);
  archive.importFile(filename, 'local', 'demo', () => 'y'.repeat(120));
  const start = archive.exportBatch(0, 100, 'metadata').events.find(event => event.kind === 'session.started')!;
  assert.equal(Array.from(start.data.title as string).length, 80);
  assert.ok((start.data.title as string).endsWith('…'));
});

test('folded rollouts keep distinct event identities and still deduplicate copies', t => {
  const { dir, archive } = setup(t);
  const parent = path.join(dir, 'parent.jsonl');
  const child = path.join(dir, 'child.jsonl');
  const record = (id: string, kind: string, payload: Record<string, unknown> = {}): string => JSON.stringify({
    timestamp: '2026-03-01T00:00:00Z',
    type: kind,
    payload: { turn_id: 'turn-1', ...payload, ...(kind === 'session_meta' ? { id, cwd: '/synthetic/folded' } : {}) },
  });
  writeFileSync(parent, [
    record('parent-session', 'session_meta'),
    record('', 'event_msg', { type: 'task_started' }),
    record('', 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }),
  ].join('\n') + '\n');
  // Subagent rollout: its own identity first, the parent identity last.
  writeFileSync(child, [
    record('child-session', 'session_meta'),
    record('parent-session', 'session_meta'),
    record('', 'event_msg', { type: 'task_started' }),
    record('', 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } }),
  ].join('\n') + '\n');

  const parentReport = archive.importFile(parent, 'local', 'demo');
  const childReport = archive.importFile(child, 'local', 'demo');
  assert.equal(parentReport.imported, 3);
  assert.equal(childReport.imported, 3);
  const batch = archive.exportBatch(0, 100, 'metadata');
  assert.equal(batch.events.length, 6);
  assert.equal(new Set(batch.events.map(event => event.event_id)).size, 6);
  assert.ok(batch.events.every(event => event.session_id === 'parent-session'));

  // A copied child rollout is the same evidence even though its path changed.
  const copy = path.join(dir, 'child-copy.jsonl');
  copyFileSync(child, copy);
  assert.equal(archive.importFile(copy, 'local', 'demo').imported, 0);
  assert.equal(archive.exportBatch(0, 100, 'metadata').events.length, 6);
});

test('single-identity logs keep the published v1 event identifier', t => {
  const { archive } = setup(t);
  archive.importFile(fixture, 'local', 'demo');
  const events = archive.exportBatch(0, 100, 'metadata').events;
  const line = 1;
  const expected = hash(JSON.stringify(['codex', 'local', 'archive-demo-session', line]));
  assert.ok(events.some(event => event.event_id === expected));
});

test('folded events expose the source series used by their identifier', t => {
  const { dir, archive } = setup(t);
  const child = path.join(dir, 'series-child.jsonl');
  writeFileSync(child, [
    JSON.stringify({ timestamp: '2026-04-01T00:00:00Z', type: 'session_meta', payload: { id: 'child-id', cwd: '/synthetic/series' } }),
    JSON.stringify({ timestamp: '2026-04-01T00:00:01Z', type: 'session_meta', payload: { id: 'parent-id', cwd: '/synthetic/series' } }),
    JSON.stringify({ timestamp: '2026-04-01T00:00:02Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } }),
  ].join('\n') + '\n');
  archive.importFile(child, 'local', 'demo');
  const events = archive.exportBatch(0, 100, 'metadata').events;
  const folded = events.find(event => event.kind === 'turn.started')!;
  assert.equal(folded.source!.series, 'child-id');
  assert.equal(folded.session_id, 'parent-id');
  const start = events.find(event => event.kind === 'session.started')!;
  assert.equal(start.source!.series, 'child-id');
  assert.equal(start.body, null);
});
