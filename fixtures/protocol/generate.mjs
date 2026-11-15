#!/usr/bin/env node
// Protocol-v1 conformance fixtures shared by every archive consumer.
//
// These fixtures describe the *page contract* (batch envelope + event envelope),
// not a specific consumer's storage. They are deliberately small and synthetic:
// no real session content, paths or credentials. Consumers should load them with
// their own validators and assert the expected accept/reject outcome from
// manifest.json instead of importing this file into production code.
//
// Regenerate after editing: node generate.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = (value) => createHash('sha256').update(value).digest('hex');

const ARCHIVE_ID = '00000000-0000-4000-8000-000000000001';
const RUNTIME = 'codex';
const INSTANCE = 'fixture-device';
const SESSION = '11111111-2222-4333-8444-555555555555';
const SESSION_KEY = JSON.stringify([RUNTIME, INSTANCE, SESSION]);
const PROJECT = 'fixture';
const SOURCE_PATH = '/selected/rollout-fixture.jsonl';

const eventId = (line) => sha(JSON.stringify([RUNTIME, INSTANCE, SESSION, line]));
const eventIdFor = (sessionId, line) => sha(JSON.stringify([RUNTIME, INSTANCE, sessionId, line]));
const deletionId = () => sha(JSON.stringify([RUNTIME, INSTANCE, SESSION, 'deleted']));
const recordHash = (line) => sha(`fixture-line-${line}`);
const common = { turn_id: 'turn-1', root_turn_id: null, model: 'fixture-model' };

function event({ seq, line, kind, data = {}, body = null, raw = null, occurredAt = '2026-01-01T00:00:00.000Z', observedAt = '2026-01-01T00:00:01.000Z' }) {
  const deleted = kind === 'session.deleted';
  return {
    schema_version: 1,
    event_id: deleted ? deletionId() : eventId(line),
    archive_seq: seq,
    runtime: RUNTIME,
    instance_id: INSTANCE,
    session_id: SESSION,
    session_key: SESSION_KEY,
    project_id: PROJECT,
    kind,
    occurred_at: occurredAt,
    observed_at: observedAt,
    native_type: 'fixture.line',
    source: deleted ? null : { path: SOURCE_PATH, line, record_hash: recordHash(line) },
    data: deleted ? {} : data,
    body: deleted ? null : body,
    raw: deleted ? null : raw,
  };
}

function page(events, { after = 0, next = events.length ? events[events.length - 1].archive_seq : after, hasMore = false, view = 'content', archiveId = ARCHIVE_ID } = {}) {
  return { schema_version: 1, archive_id: archiveId, view, after_cursor: after, next_cursor: next, has_more: hasMore, events };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

// A complete, valid content page for one small session.
const contentEvents = [
  event({
    seq: 1, line: 1, kind: 'session.started',
    data: { ...common, cwd: '/workspace/fixture', created_at: '2026-01-01T00:00:00.000Z', cli_version: 'fixture-1.0.0', title: 'Fixture session' },
    occurredAt: '2026-01-01T00:00:00.000Z',
  }),
  event({
    seq: 2, line: 2, kind: 'message.user',
    data: { ...common, title: 'Say hello' },
    body: { text: 'Hello, run the fixture.' },
    occurredAt: '2026-01-01T00:00:01.000Z',
  }),
  event({
    seq: 3, line: 3, kind: 'tool.called',
    data: { ...common, call_id: 'call-1', name: 'exec', input_bytes: 15 },
    body: { arguments: { cmd: 'echo hello' } },
    occurredAt: '2026-01-01T00:00:02.000Z',
  }),
  event({
    seq: 4, line: 4, kind: 'tool.returned',
    data: { ...common, call_id: 'call-1', output_bytes: 6, status: 'result_observed' },
    body: { output: 'hello\n' },
    occurredAt: '2026-01-01T00:00:03.000Z',
  }),
  event({
    seq: 5, line: 5, kind: 'usage.snapshot',
    data: {
      ...common, rate_limit_only: false,
      cumulative: { input_tokens: 1200, output_tokens: 120 },
      last_usage: { input_tokens: 1200, output_tokens: 120 },
      cost_usd: 0.0012, cost_source: 'model_rates',
    },
    occurredAt: '2026-01-01T00:00:04.000Z',
  }),
  event({
    seq: 6, line: 6, kind: 'turn.completed',
    data: { ...common },
    body: { text: 'fixture completed' },
    occurredAt: '2026-01-01T00:00:05.000Z',
  }),
];

const contentPage = page(contentEvents, { after: 0, next: 6, hasMore: false });

// The tombstone that follows the content page, in the same cursor space.
const deletionPage = page([
  event({
    seq: 7, line: null, kind: 'session.deleted',
    occurredAt: '2026-01-01T00:00:06.000Z',
    observedAt: '2026-01-01T00:00:07.000Z',
  }),
], { after: 6, next: 7, hasMore: false });

// Empty tail: a valid page that advances nothing.
const emptyMetadataPage = page([], { after: 0, next: 0, hasMore: false, view: 'metadata' });

// Content view can externalize an oversized value. The reference is valid and
// consumers must preserve it without reading the path.
const refSession = '22222222-3333-4444-8555-666666666666';
const refSessionKey = JSON.stringify([RUNTIME, INSTANCE, refSession]);
const refBlobSha = sha('fixture externalized output');
const refPage = page([
  {
    schema_version: 1,
    event_id: eventIdFor(refSession, 1),
    archive_seq: 1,
    runtime: RUNTIME,
    instance_id: INSTANCE,
    session_id: refSession,
    session_key: refSessionKey,
    project_id: PROJECT,
    kind: 'tool.returned',
    occurred_at: '2026-01-01T01:00:00.000Z',
    observed_at: '2026-01-01T01:00:01.000Z',
    native_type: 'fixture.line',
    source: { path: SOURCE_PATH, line: 1, record_hash: recordHash(1) },
    data: { ...common, call_id: 'call-2', output_bytes: 1234, status: 'result_observed' },
    body: { output: { content_ref: { path: `/private/blobs/fixture-${refBlobSha}.txt`, bytes: 1234, sha256: refBlobSha, media_type: 'text/plain' } } },
    raw: null,
  },
], { after: 0, next: 1, hasMore: false });

// ---- invalid cases -------------------------------------------------------
const invalid = {};

invalid['unsupported-version'] = (() => {
  const value = clone(contentPage); value.schema_version = 2; return value;
})();

invalid['unknown-envelope-field'] = (() => {
  const value = clone(contentPage); value.unexpected = true; return value;
})();

invalid['wrong-view'] = (() => {
  const value = clone(contentPage); value.view = 'metadata'; return value;
})();

invalid['cursor-gap'] = (() => {
  const value = clone(contentPage);
  value.after_cursor = 1;
  value.events = value.events.filter((entry) => entry.archive_seq >= 2);
  return value;
})();

invalid['non-advancing-cursor'] = (() => {
  const value = clone(contentPage);
  value.after_cursor = 0; value.next_cursor = 0; value.has_more = true; value.events = [];
  return value;
})();

invalid['unordered-events'] = (() => {
  const value = clone(contentPage);
  [value.events[1], value.events[2]] = [value.events[2], value.events[1]];
  return value;
})();

invalid['event-beyond-cursor'] = (() => {
  const value = clone(contentPage);
  value.events[value.events.length - 1].archive_seq = 99;
  return value;
})();

invalid['bad-session-key'] = (() => {
  const value = clone(contentPage);
  value.events[1].session_key = '["codex","fixture-device","other-session"]';
  return value;
})();

invalid['bad-event-id'] = (() => {
  const value = clone(contentPage);
  value.events[1].event_id = 'a'.repeat(64);
  return value;
})();

invalid['missing-source'] = (() => {
  const value = clone(contentPage);
  value.events[1].source = null;
  return value;
})();

invalid['deletion-marker-with-body'] = (() => {
  const value = clone(deletionPage);
  value.events[0].body = { text: 'must be null' };
  return value;
})();

invalid['duplicate-event-id'] = (() => {
  const value = clone(contentPage);
  // Same line means the identity rule itself passes; the page is invalid only
  // because the consumer has already stored that event identity.
  value.events[3].source.line = value.events[2].source.line;
  value.events[3].event_id = value.events[2].event_id;
  return value;
})();

invalid['unknown-metadata-field'] = (() => {
  const value = clone(contentPage);
  value.events[0].data.token = 'not-allowlisted';
  return value;
})();

invalid['negative-usage'] = (() => {
  const value = clone(contentPage);
  value.events[4].data.cumulative.input_tokens = -1;
  return value;
})();

invalid['content-ref-relative-path'] = (() => {
  const value = clone(refPage);
  value.events[0].body.output.content_ref.path = 'blobs/fixture.txt';
  return value;
})();

invalid['content-ref-wrong-media-type'] = (() => {
  const value = clone(refPage);
  value.events[0].body.output.content_ref.media_type = 'application/octet-stream';
  return value;
})();

// ---- manifest ------------------------------------------------------------
const manifest = {
  schema_version: 1,
  protocol: 'archive-v1',
  notes: [
    'Fixtures describe the page contract; they are not production data.',
    'archive identity mismatch (ARCHIVE_CHANGED) is state-dependent and is exercised by consumer tests that bind a state first, so it is not a standalone fixture.',
    'PAGE_TOO_LARGE and VIEW_UNAVAILABLE are server/status-level errors, not page fixtures.',
    'Each consumer maps these semantic outcomes to its own error codes; expected_code below follows the consumer-follow contract where one exists.',
  ],
  fixtures: [
    { file: 'valid/content-page-1.json', view: 'content', valid: true, layer: 'page', expect: { follow: 'accept', import: 'accept' }, covers: ['session.started', 'message.user', 'tool.called', 'tool.returned', 'usage.snapshot', 'turn.completed'] },
    { file: 'valid/content-deletion-page.json', view: 'content', valid: true, layer: 'page', expect: { follow: 'accept', import: 'accept' }, notes: 'Must be applied after content-page-1 with cursor 6; the tombstone erases the session evidence.' },
    { file: 'valid/metadata-empty-page.json', view: 'metadata', valid: true, layer: 'page', expect: { follow: 'accept (metadata consumer)', import: 'not applicable (content-only importer)' }, notes: 'Empty tail may advance nothing; metadata consumers only.' },
    { file: 'valid/content-ref-page.json', view: 'content', valid: true, layer: 'page', expect: { follow: 'accept', import: 'accept' }, notes: 'Body carries a valid content_ref; consumers must not read the path during import/search.' },
    { file: 'invalid/unsupported-version.json', valid: false, layer: 'page', reason: 'batch schema_version is not 1', expected_code: { follow: 'INVALID_PAGE', import: 'INVALID_ARCHIVE' } },
    { file: 'invalid/unknown-envelope-field.json', valid: false, layer: 'page', reason: 'unknown batch field', expected_code: { follow: 'INVALID_PAGE', import: 'INVALID_ARCHIVE' } },
    { file: 'invalid/wrong-view.json', valid: false, layer: 'page', reason: 'view does not match the consumer binding', expected_code: { follow: 'INVALID_PAGE', import: 'INVALID_ARCHIVE' } },
    { file: 'invalid/cursor-gap.json', valid: false, layer: 'page', reason: 'after_cursor is ahead of the committed cursor', expected_code: { follow: 'INVALID_PAGE', import: 'INVALID_ARCHIVE' } },
    { file: 'invalid/non-advancing-cursor.json', valid: false, layer: 'page', reason: 'has_more=true without advancing next_cursor', expected_code: { follow: 'INVALID_PAGE', import: 'INVALID_ARCHIVE' } },
    { file: 'invalid/unordered-events.json', valid: false, layer: 'page', reason: 'events are not ordered by archive_seq', expected_code: { follow: 'INVALID_PAGE', import: 'INVALID_ARCHIVE' } },
    { file: 'invalid/event-beyond-cursor.json', valid: false, layer: 'page', reason: 'event sequence is beyond next_cursor', expected_code: { follow: 'INVALID_PAGE', import: 'INVALID_ARCHIVE' } },
    { file: 'invalid/bad-session-key.json', valid: false, layer: 'event', reason: 'session_key does not match [runtime, instance_id, session_id]', expected_code: { follow: 'INVALID_PAGE', import: 'INVALID_ARCHIVE' } },
    { file: 'invalid/bad-event-id.json', valid: false, layer: 'event', reason: 'codex event identity does not match sha256([runtime, instance_id, session_id, line])', expected_code: { follow: 'INVALID_PAGE', import: 'INVALID_ARCHIVE' } },
    { file: 'invalid/missing-source.json', valid: false, layer: 'event', reason: 'non-deletion event has no source reference', expected_code: { follow: 'INVALID_PAGE', import: 'INVALID_ARCHIVE' } },
    { file: 'invalid/deletion-marker-with-body.json', valid: false, layer: 'event', reason: 'deletion markers must have null source/body/raw and empty data', expected_code: { follow: 'INVALID_PAGE', import: 'INVALID_ARCHIVE' } },
    { file: 'invalid/duplicate-event-id.json', valid: false, layer: 'event', reason: 'two events in a page share an event identity', expected_code: { follow: 'INVALID_PAGE', import: 'INVALID_ARCHIVE' } },
    { file: 'invalid/unknown-metadata-field.json', valid: false, layer: 'event', reason: 'data contains a field outside the kind allowlist', expected_code: { follow: 'INVALID_PAGE', import: 'INVALID_ARCHIVE' } },
    { file: 'invalid/negative-usage.json', valid: false, layer: 'event', reason: 'usage token counts must be nonnegative integers', expected_code: { follow: 'INVALID_PAGE', import: 'INVALID_ARCHIVE' } },
    { file: 'invalid/content-ref-relative-path.json', valid: false, layer: 'event', reason: 'content_ref.path must be absolute', expected_code: { follow: 'INVALID_PAGE', import: 'INVALID_ARCHIVE' } },
    { file: 'invalid/content-ref-wrong-media-type.json', valid: false, layer: 'event', reason: 'content_ref.media_type must be text/plain', expected_code: { follow: 'INVALID_PAGE', import: 'INVALID_ARCHIVE' } },
  ],
};

// ---- write ---------------------------------------------------------------
function writeJson(relative, value) {
  const target = path.join(here, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

writeJson('valid/content-page-1.json', contentPage);
writeJson('valid/content-deletion-page.json', deletionPage);
writeJson('valid/metadata-empty-page.json', emptyMetadataPage);
writeJson('valid/content-ref-page.json', refPage);
for (const [name, value] of Object.entries(invalid)) writeJson(`invalid/${name}.json`, value);
writeJson('manifest.json', manifest);

// Self-check: the valid pages must satisfy the documented identity rules.
const assert = (condition, message) => { if (!condition) throw new Error(message); };
for (const entry of contentPage.events.filter((item) => item.kind !== 'session.deleted')) {
  assert(entry.event_id === eventId(entry.source.line), `bad event id in valid page: ${entry.kind}`);
  assert(entry.session_key === SESSION_KEY, `bad session key in valid page: ${entry.kind}`);
}
assert(deletionPage.events[0].event_id === deletionId(), 'bad deletion event id');
assert(new Set(contentPage.events.map((item) => item.event_id)).size === contentPage.events.length, 'duplicate event ids in valid page');
assert(refPage.events[0].event_id === eventIdFor(refSession, 1), 'bad content_ref event id');
assert(refPage.events[0].session_key === refSessionKey, 'bad content_ref session key');
assert(manifest.fixtures.length === 4 + Object.keys(invalid).length, 'manifest does not cover every fixture');

process.stdout.write(`wrote ${4 + Object.keys(invalid).length + 1} fixtures to ${here}\n`);
