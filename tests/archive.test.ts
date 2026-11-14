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
