import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, renameSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Archive } from '../src/store.ts';
import {
  Collector,
  acquireCollectionLease,
  ensureCollectionSchema,
  releaseCollectionLease,
  renewCollectionLease,
} from '../src/collector.ts';
import {
  STATS_TOKEN_HASH,
  appendExtraEvent,
  fixtureLog,
  loadConfig,
  temporaryDirectory,
  writeServiceConfig,
} from './support.ts';

interface Fixture {
  dir: string;
  project: string;
  logs: string;
  file: string;
  configFile: string;
  database: string;
}

function setup(
  t: test.TestContext,
  backfill: 'none' | 'all' = 'all',
  options: { cwd?: string; files?: number } = {},
): Fixture {
  const dir = temporaryDirectory(t);
  const project = path.join(dir, 'project');
  const logs = path.join(dir, 'logs');
  mkdirSync(project, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const file = path.join(logs, 'session.jsonl');
  writeFileSync(file, fixtureLog(options.cwd ?? project));
  const configFile = writeServiceConfig(dir, {
    database: 'state/trace.sqlite',
    captureMode: 'content',
    collection: {
      enabled: true,
      scan_interval_seconds: 1,
      backfill,
      sources: [{
        instance_id: 'synthetic-device',
        root: 'logs',
        projects: [{ project_id: 'demo', cwd_allowlist: ['project'] }],
      }],
    },
    api: { enabled: false },
  });
  return { dir, project, logs, file, configFile, database: path.join(dir, 'state/trace.sqlite') };
}

function open(fixture: Fixture): { archive: Archive; collector: Collector } {
  const config = loadConfig(fixture.configFile);
  const archive = new Archive(config.database, config.capture_mode);
  const collector = new Collector(config, archive, { scheduleScans: false });
  return { archive, collector };
}

test('backfill none records a baseline, then imports only new or changed files', async t => {
  const fixture = setup(t, 'none');
  const { archive, collector } = open(fixture);
  t.after(() => archive.close());

  const baseline = await collector.scanOnce();
  assert.equal(baseline.files, 1);
  assert.equal(baseline.imported, 0);
  assert.equal(baseline.errors, 0);
  assert.equal(archive.highWatermark(), 0);

  appendExtraEvent(fixture.file);
  const changed = await collector.scanOnce();
  assert.equal(changed.files, 1);
  assert.equal(changed.imported, 12);
  assert.equal(changed.skipped, 0);
  assert.equal(archive.highWatermark(), 12);

  const unchanged = await collector.scanOnce();
  assert.equal(unchanged.imported, 0);
  assert.equal(unchanged.skipped, 0);
  assert.equal(archive.highWatermark(), 12);
  assert.equal(collector.status().sources[0]!.last_scan_at !== null, true);
});

test('project matching uses the session cwd and re-evaluates files after scope changes', async t => {
  const fixture = setup(t, 'all', { cwd: '/synthetic/outside' });
  const first = open(fixture);
  t.after(() => first.archive.close());
  const skipped = await first.collector.scanOnce();
  assert.equal(skipped.imported, 0);
  assert.equal(skipped.unmatched_projects, 1);
  assert.equal(skipped.errors, 0);
  assert.equal(first.archive.highWatermark(), 0);

  // The same source identity/root with a corrected allowlist must retry the
  // previously unmatched file instead of requiring a new archive.
  writeServiceConfig(fixture.dir, {
    database: 'state/trace.sqlite',
    captureMode: 'content',
    collection: {
      enabled: true,
      scan_interval_seconds: 1,
      backfill: 'all',
      sources: [{
        instance_id: 'synthetic-device',
        root: 'logs',
        projects: [{ project_id: 'demo', cwd_allowlist: ['/synthetic/outside'] }],
      }],
    },
    api: { enabled: false },
  });
  const config = loadConfig(fixture.configFile);
  const second = new Collector(config, first.archive, { scheduleScans: false });
  const imported = await second.scanOnce();
  assert.equal(imported.imported, 11);
  assert.equal(imported.unmatched_projects, 0);
  assert.equal(first.archive.highWatermark(), 11);
  assert.ok(first.archive.exportBatch(0, 100).events.every(event => event.project_id === 'demo'));
});

test('partial tails wait, malformed lines roll back, and rewrites replace the newer revision', async t => {
  const fixture = setup(t, 'all');
  const { archive, collector } = open(fixture);
  t.after(() => archive.close());
  const full = fixtureLog(fixture.project);

  writeFileSync(fixture.file, full.slice(0, -1));
  const partial = await collector.scanOnce();
  assert.equal(partial.imported, 10);
  assert.equal(partial.pending, 1);
  assert.equal(archive.highWatermark(), 10);

  const stillPartial = await collector.scanOnce();
  assert.equal(stillPartial.imported, 0);
  assert.equal(stillPartial.pending, 1);
  assert.equal(archive.highWatermark(), 10);

  writeFileSync(fixture.file, full);
  const completed = await collector.scanOnce();
  assert.equal(completed.imported, 1);
  assert.equal(completed.skipped, 10);
  assert.equal(completed.pending, 0);
  assert.equal(archive.highWatermark(), 11);

  appendFileSync(fixture.file, '{broken}\n');
  const malformed = await collector.scanOnce();
  assert.equal(malformed.errors, 1);
  assert.match(JSON.stringify(collector.status().sources[0]!.last_error), /INVALID_RECORD/);
  assert.equal(archive.highWatermark(), 11);

  writeFileSync(fixture.file, full);
  const repaired = await collector.scanOnce();
  assert.equal(repaired.errors, 0);
  assert.equal(repaired.skipped, 11);
  assert.equal(archive.highWatermark(), 11);

  // An in-place rewrite of equal size is reconciled: the changed record is
  // replaced without retrying forever and without touching other events.
  writeFileSync(fixture.file, full.replace('"task_complete"', '"turn_aborted"'));
  const rewrite = await collector.scanOnce();
  assert.equal(rewrite.errors, 0);
  assert.equal(rewrite.imported, 1);
  assert.equal(rewrite.skipped, 10);
  assert.equal(archive.highWatermark(), 12);
  assert.ok(archive.exportBatch(0, 100, 'metadata').events.some(event => event.kind === 'turn.interrupted'));
  writeFileSync(fixture.file, full);
  const restored = await collector.scanOnce();
  assert.equal(restored.errors, 0);
  assert.equal(restored.imported, 1);
  assert.equal(restored.skipped, 10);
  assert.equal(archive.highWatermark(), 13);

  const missingSession = path.join(fixture.logs, 'no-meta.jsonl');
  writeFileSync(missingSession, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
  const invalidIdentity = await collector.scanOnce();
  assert.equal(invalidIdentity.errors, 1);
  assert.equal(invalidIdentity.unmatched_projects, 0);
  unlinkSync(missingSession);
});

test('moved and copied files deduplicate while one failing source does not stop another', async t => {
  const fixture = setup(t, 'all');
  // Add a second source whose root does not exist yet.
  writeServiceConfig(fixture.dir, {
    database: 'state/trace.sqlite',
    captureMode: 'content',
    collection: {
      enabled: true,
      scan_interval_seconds: 1,
      backfill: 'all',
      sources: [
        { instance_id: 'missing-device', root: 'missing', projects: [{ project_id: 'demo', cwd_allowlist: ['project'] }] },
        { instance_id: 'synthetic-device', root: 'logs', projects: [{ project_id: 'demo', cwd_allowlist: ['project'] }] },
      ],
    },
    api: { enabled: false },
  });
  const { archive, collector } = open(fixture);
  t.after(() => archive.close());

  const first = await collector.scanOnce();
  assert.equal(first.imported, 11);
  assert.equal(first.errors, 1);
  assert.equal(archive.highWatermark(), 11);
  assert.equal(collector.status().state, 'degraded');
  const missing = collector.status().sources.find(source => source.instance_id === 'missing-device')!;
  assert.match(missing.last_error!.code, /ENOENT|SOURCE/);

  const copy = path.join(fixture.logs, 'copy.jsonl');
  cpSync(fixture.file, copy);
  const copied = await collector.scanOnce();
  assert.equal(copied.imported, 0);
  assert.equal(copied.skipped, 11);
  assert.equal(archive.highWatermark(), 11);

  const archiveDir = path.join(fixture.logs, 'archive');
  mkdirSync(archiveDir);
  const moved = path.join(archiveDir, 'moved.jsonl');
  renameSync(fixture.file, moved);
  appendExtraEvent(moved);
  const movedReport = await collector.scanOnce();
  assert.equal(movedReport.imported, 1);
  assert.equal(movedReport.skipped, 11);
  assert.equal(archive.highWatermark(), 12);
});

test('oversized source files are reported without blocking valid files', async t => {
  const fixture = setup(t, 'all');
  const { archive, collector } = open(fixture);
  t.after(() => archive.close());
  const oversized = path.join(fixture.logs, 'too-big.jsonl');
  writeFileSync(oversized, '');
  truncateSync(oversized, 128 * 1024 * 1024 + 1);
  const report = await collector.scanOnce();
  assert.equal(report.files, 2);
  assert.equal(report.imported, 11);
  assert.equal(report.errors, 1);
  assert.match(collector.status().sources[0]!.last_error!.code, /FILE_TOO_LARGE/);
  assert.equal(archive.highWatermark(), 11);
});

test('deleted sessions are not resurrected by the scanner', async t => {
  const fixture = setup(t, 'all');
  const { archive, collector } = open(fixture);
  t.after(() => archive.close());
  await collector.scanOnce();
  assert.equal(archive.highWatermark(), 11);
  archive.deleteSession('codex', 'synthetic-device', 'archive-demo-session');
  assert.equal(archive.highWatermark(), 12);

  appendExtraEvent(fixture.file);
  const report = await collector.scanOnce();
  assert.equal(report.errors, 1);
  assert.equal(archive.highWatermark(), 12);
  assert.equal(archive.exportBatch(0, 100).events.filter(event => event.kind === 'session.deleted').length, 1);
});

test('collection leases reject a second owner, expire, and serialize tasks', async t => {
  const dir = temporaryDirectory(t);
  const database = path.join(dir, 'trace.sqlite');
  const first = new Archive(database, 'metadata');
  const second = new Archive(database, 'metadata');
  t.after(() => { first.close(); second.close(); });
  ensureCollectionSchema(first.db);

  assert.deepEqual(acquireCollectionLease(first.db, 'owner-a', 1_000, 1_000), { acquired: true, owner: 'owner-a', expires_at: 2_000 });
  assert.equal(acquireCollectionLease(second.db, 'owner-b', 1_000, 1_500).acquired, false);
  assert.equal(acquireCollectionLease(second.db, 'owner-b', 1_000, 2_001).acquired, true);
  assert.throws(() => renewCollectionLease(first.db, 'owner-a', 1_000, 2_100), /no longer owned/);
  assert.doesNotThrow(() => renewCollectionLease(second.db, 'owner-b', 1_000, 2_100));
  assert.equal(releaseCollectionLease(second.db, 'owner-b'), true);
  assert.equal(releaseCollectionLease(second.db, 'owner-b'), false);

  const configFile = writeServiceConfig(dir, {
    database: 'trace.sqlite',
    collection: { enabled: true, scan_interval_seconds: 60, backfill: 'none', sources: [] },
    api: { enabled: false },
  });
  // An enabled collection requires at least one source; use a real but empty root.
  mkdirSync(path.join(dir, 'logs'));
  writeFileSync(configFile, JSON.stringify({
    schema_version: 1,
    database: 'trace.sqlite',
    collection: {
      enabled: true,
      scan_interval_seconds: 60,
      backfill: 'none',
      sources: [{ instance_id: 'lease-device', root: 'logs', projects: [{ project_id: 'demo', cwd_allowlist: ['project'] }] }],
    },
    api: { enabled: false },
  }));
  const config = loadConfig(configFile);
  const owner = new Collector(config, first, { scheduleScans: false });
  const contender = new Collector(config, second, { scheduleScans: false });
  owner.start();
  assert.throws(() => contender.start(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'COLLECTION_LOCKED');
    return true;
  });
  const busy = owner.scanOnce();
  await assert.rejects(owner.scanOnce(), /already running/);
  await busy;
  await owner.stop();
  contender.start();
  await contender.stop();
});

test('checked-in service tokens are not required by the collector fixture', () => {
  // Keeps support constants exercised without reading or printing any secret.
  assert.match(STATS_TOKEN_HASH, /^[0-9a-f]{64}$/);
});

test('collector attaches session names from the source metadata home', async t => {
  const fixture = setup(t, 'all');
  writeFileSync(path.join(fixture.logs, 'session_index.jsonl'),
    JSON.stringify({ id: 'archive-demo-session', thread_name: 'Synthetic named session' }) + '\n');
  const { archive, collector } = open(fixture);
  t.after(() => archive.close());

  const summary = await collector.scanOnce();
  assert.equal(summary.imported, 11);
  const start = archive.exportBatch(0, 100, 'metadata').events
    .find(event => event.kind === 'session.started')!;
  assert.equal(start.data.title, 'Synthetic named session');
  assert.equal(start.body, null);
});
