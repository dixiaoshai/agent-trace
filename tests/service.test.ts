import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Archive } from '../src/store.ts';
import { TraceService, type ServiceEvent } from '../src/service.ts';
import { acquireCollectionLease, ensureCollectionSchema } from '../src/collector.ts';
import {
  KNOWLEDGE_TOKEN,
  KNOWLEDGE_TOKEN_HASH,
  STATS_TOKEN,
  STATS_TOKEN_HASH,
  appendExtraEvent,
  fixtureLog,
  freeLoopbackPort,
  loadConfig,
  request,
  temporaryDirectory,
  waitFor,
  writeServiceConfig,
} from './support.ts';

function errorCode(response: Awaited<ReturnType<typeof request>>): string {
  return response.json?.error?.code ?? '';
}

test('serve scans new logs and exposes the authenticated read-only API', async t => {
  const dir = temporaryDirectory(t);
  const project = path.join(dir, 'project');
  const logs = path.join(dir, 'logs');
  mkdirSync(project, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const file = path.join(logs, 'session.jsonl');
  writeFileSync(file, fixtureLog(project));
  const port = await freeLoopbackPort();
  const configFile = writeServiceConfig(dir, {
    database: 'state/trace.sqlite',
    captureMode: 'content',
    collection: {
      enabled: true,
      scan_interval_seconds: 1,
      backfill: 'all',
      sources: [{
        instance_id: 'synthetic-device',
        root: 'logs',
        projects: [{ project_id: 'demo', cwd_allowlist: ['project'] }],
      }],
    },
    api: {
      enabled: true,
      host: '127.0.0.1',
      port,
      clients: [
        { id: 'agent-stats', views: ['metadata'], token_sha256: STATS_TOKEN_HASH },
        { id: 'agent-knowledge', views: ['content'], token_sha256: KNOWLEDGE_TOKEN_HASH },
      ],
    },
  });
  const config = loadConfig(configFile);
  const events: ServiceEvent[] = [];
  const service = new TraceService(config, { onEvent: event => events.push(event) });
  t.after(async () => { await service.stop('test-cleanup'); });
  await service.start();

  const statusResponse = await waitFor(async () => {
    const response = await request(port, '/v1/status', { token: STATS_TOKEN });
    return response.status === 200 && response.json?.archive?.high_watermark === 11 ? response : null;
  });
  assert.equal(statusResponse.json.schema_version, 1);
  assert.equal(statusResponse.json.archive.archive_id, service.archive.archiveId);
  assert.equal(statusResponse.json.archive.capture_mode, 'content');
  assert.equal(statusResponse.json.collection.enabled, true);
  assert.equal(statusResponse.json.collection.scan_interval_seconds, 1);
  assert.equal(statusResponse.json.collection.sources[0].instance_id, 'synthetic-device');
  assert.doesNotMatch(statusResponse.body, new RegExp(STATS_TOKEN_HASH));
  assert.doesNotMatch(statusResponse.body, new RegExp(STATS_TOKEN));

  const metadata = await request(port, '/v1/events?after=0&limit=100&view=metadata', { token: STATS_TOKEN });
  assert.equal(metadata.status, 200);
  assert.equal(metadata.headers['cache-control'], 'no-store');
  assert.equal(metadata.json.archive_id, service.archive.archiveId);
  assert.equal(metadata.json.view, 'metadata');
  assert.equal(metadata.json.after_cursor, 0);
  assert.equal(metadata.json.next_cursor, 11);
  assert.equal(metadata.json.has_more, false);
  assert.equal(metadata.json.events.length, 11);
  assert.ok(metadata.json.events.every((event: any) => event.body === null && event.raw === null));
  assert.doesNotMatch(metadata.body, /SYNTHETIC_PRIVATE|SYNTHETIC_FUTURE/);
  const empty = await request(port, '/v1/events?after=11&limit=100&view=metadata', { token: STATS_TOKEN });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.events, []);
  assert.equal(empty.json.after_cursor, 11);
  assert.equal(empty.json.next_cursor, 11);
  assert.equal(empty.json.has_more, false);

  const content = await request(port, '/v1/events?after=0&limit=10&view=content', { token: KNOWLEDGE_TOKEN });
  assert.equal(content.status, 200);
  assert.equal(content.json.events.length, 10);
  assert.equal(content.json.next_cursor, 10);
  assert.equal(content.json.has_more, true);
  assert.match(content.body, /SYNTHETIC_PRIVATE_ARGUMENT/);

  // GET is read-only: repeating it must not move a cursor or change the watermark.
  const repeated = await request(port, '/v1/events?after=0&limit=100&view=metadata', { token: STATS_TOKEN });
  assert.deepEqual(repeated.json, metadata.json);
  const unchangedStatus = await request(port, '/v1/status', { token: STATS_TOKEN });
  assert.equal(unchangedStatus.json.archive.high_watermark, 11);

  assert.equal(errorCode(await request(port, '/v1/events')), 'UNAUTHORIZED');
  assert.equal(errorCode(await request(port, '/v1/events', { token: 'wrong-token' })), 'UNAUTHORIZED');
  assert.equal(errorCode(await request(port, '/v1/events?view=content', { token: STATS_TOKEN })), 'FORBIDDEN_VIEW');
  assert.equal(errorCode(await request(port, '/v1/events?view=metadata', { token: KNOWLEDGE_TOKEN })), 'FORBIDDEN_VIEW');
  assert.equal(errorCode(await request(port, '/v1/events', { token: STATS_TOKEN, host: 'example.com' })), 'INVALID_HOST');
  assert.equal(errorCode(await request(port, '/v1/events', { token: STATS_TOKEN, origin: `http://evil.example:${port}` })), 'INVALID_ORIGIN');
  assert.equal(errorCode(await request(port, '/v1/events', { token: STATS_TOKEN, method: 'POST' })), 'METHOD_NOT_ALLOWED');
  assert.equal(errorCode(await request(port, '/v1/unknown', { token: STATS_TOKEN })), 'NOT_FOUND');
  assert.equal(errorCode(await request(port, '/v1/events?after=999999', { token: STATS_TOKEN })), 'INVALID_CURSOR');
  assert.equal(errorCode(await request(port, '/v1/events?limit=1001', { token: STATS_TOKEN })), 'INVALID_INPUT');
  assert.equal(errorCode(await request(port, '/v1/status?after=1', { token: STATS_TOKEN })), 'INVALID_INPUT');
  assert.equal(errorCode(await request(port, '/v1/events?project_id=demo', { token: STATS_TOKEN })), 'INVALID_INPUT');

  appendExtraEvent(file);
  await waitFor(async () => {
    const response = await request(port, '/v1/status', { token: STATS_TOKEN });
    return response.json?.archive?.high_watermark === 12 ? response : null;
  });
  const next = await request(port, '/v1/events?after=11&limit=100&view=metadata', { token: STATS_TOKEN });
  assert.equal(next.json.events.length, 1);
  assert.equal(next.json.next_cursor, 12);
  assert.equal(next.json.events[0].kind, 'message.user');

  // A deletion is exposed as a tombstone; the unchanged source does not
  // silently restore the session on the next scan.
  assert.equal(service.archive.deleteSession('codex', 'synthetic-device', 'archive-demo-session').deleted, true);
  const tombstone = await request(port, '/v1/events?after=12&limit=10&view=metadata', { token: STATS_TOKEN });
  assert.equal(tombstone.json.events.length, 1);
  assert.equal(tombstone.json.events[0].kind, 'session.deleted');
  assert.equal(tombstone.json.next_cursor, 13);
  appendExtraEvent(file);
  await waitFor(async () => {
    const response = await request(port, '/v1/status', { token: STATS_TOKEN });
    return response.json?.collection?.last_error?.code === 'SESSION_DELETED' ? response : null;
  });
  assert.equal((await request(port, '/v1/status', { token: STATS_TOKEN })).json.archive.high_watermark, 13);

  assert.ok(events.some(event => event.type === 'serve.started'));
  assert.ok(events.some(event => event.type === 'collection.scan'));
  const serializedEvents = JSON.stringify(events);
  assert.doesNotMatch(serializedEvents, new RegExp(STATS_TOKEN));
  assert.doesNotMatch(serializedEvents, /SYNTHETIC_PRIVATE|SYNTHETIC_FUTURE/);

  await service.stop('test');
  assert.ok(events.some(event => event.type === 'serve.stopped' && event.reason === 'test'));

  const verifier = new Archive(config.database, config.capture_mode);
  try {
    ensureCollectionSchema(verifier.db);
    assert.equal(acquireCollectionLease(verifier.db, 'after-stop', 10_000).acquired, true);
  } finally { verifier.close(); }
});

test('api-only serve is explicit, keeps scanning disabled and enforces the page byte limit', async t => {
  const dir = temporaryDirectory(t);
  const port = await freeLoopbackPort();
  const configFile = writeServiceConfig(dir, {
    database: 'state/trace.sqlite',
    captureMode: 'content',
    collection: { enabled: false, sources: [] },
    api: {
      enabled: true,
      host: '127.0.0.1',
      port,
      clients: [{ id: 'agent-stats', views: ['metadata'], token_sha256: STATS_TOKEN_HASH }],
    },
  });
  const config = loadConfig(configFile);
  const archive = new Archive(config.database, config.capture_mode);
  try { archive.importFile(path.resolve('fixtures/codex/demo.jsonl'), 'api-only-device', 'demo'); } finally { archive.close(); }

  const service = new TraceService(config, { maxPageBytes: 256 });
  t.after(async () => { await service.stop('test-cleanup'); });
  await service.start();

  const status = await request(port, '/v1/status', { token: STATS_TOKEN });
  assert.equal(status.status, 200);
  assert.equal(status.json.collection.enabled, false);
  assert.equal(status.json.collection.state, 'disabled');
  assert.equal(status.json.collection.scan_interval_seconds, null);
  assert.equal(status.json.archive.high_watermark, 11);

  const tooLarge = await request(port, '/v1/events', { token: STATS_TOKEN });
  assert.equal(tooLarge.status, 413);
  assert.equal(errorCode(tooLarge), 'PAGE_TOO_LARGE');

  await service.stop('test');
});

test('serve refuses to start when both collection and API are disabled', async t => {
  const dir = temporaryDirectory(t);
  const configFile = writeServiceConfig(dir, {
    collection: { enabled: false, sources: [] },
    api: { enabled: false },
  });
  const service = new TraceService(loadConfig(configFile));
  await assert.rejects(service.start(), /requires collection\.enabled or api\.enabled/);
});
