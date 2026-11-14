import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApiError, DEFAULT_PAGE_EVENTS, MAX_PAGE_EVENTS, MAX_QUERY_CHARS,
  apiErrorBody, authorizeRequest, authorizeView, buildApiStatus, errorResponse, hashToken,
  httpStatusFor, parseEventsQuery, parseStatusQuery,
} from '../src/api.ts';
import type { ApiAuthConfig } from '../src/api.ts';
import { ArchiveError } from '../src/types.ts';

const STATS_TOKEN = 'synthetic-metadata-token-value';
const KNOWLEDGE_TOKEN = 'synthetic-content-token-value!!';
const auth: ApiAuthConfig = {
  host: '127.0.0.1',
  port: 8766,
  clients: [
    { id: 'agent-stats', views: ['metadata'], token_sha256: hashToken(STATS_TOKEN) },
    { id: 'agent-knowledge', views: ['content'], token_sha256: hashToken(KNOWLEDGE_TOKEN) },
  ],
};
const statsAuthorization = `Bearer ${STATS_TOKEN}`;
const knowledgeAuthorization = `Bearer ${KNOWLEDGE_TOKEN}`;

function codeOf(fn: () => unknown): { status: number; code: string } {
  try { fn(); } catch (error) {
    assert.ok(error instanceof ApiError);
    return { status: error.status, code: error.code };
  }
  assert.fail('expected an ApiError');
}

test('events query uses fixed defaults, bounds and canonical values', () => {
  assert.deepEqual(parseEventsQuery(''), { after: 0, limit: DEFAULT_PAGE_EVENTS, view: 'metadata' });
  assert.deepEqual(parseEventsQuery('after=12&limit=3&view=content'), { after: 12, limit: 3, view: 'content' });
  assert.deepEqual(parseEventsQuery('view=metadata'), { after: 0, limit: DEFAULT_PAGE_EVENTS, view: 'metadata' });
  assert.deepEqual(parseEventsQuery(`limit=${MAX_PAGE_EVENTS}`), { after: 0, limit: MAX_PAGE_EVENTS, view: 'metadata' });
  for (const query of ['after=-1', 'after=1.5', 'after=01', 'after=abc', 'after=9007199254740992']) {
    assert.equal(codeOf(() => parseEventsQuery(query)).code, 'INVALID_CURSOR', query);
  }
  for (const query of ['after=', 'limit=0', `limit=${MAX_PAGE_EVENTS + 1}`, 'limit=01', 'limit=1.5', 'limit=', `limit=${'9'.repeat(20)}`]) {
    assert.equal(codeOf(() => parseEventsQuery(query)).code, 'INVALID_INPUT', query);
  }
  for (const query of ['view=all', 'view=', 'project_id=demo', 'after=1&after=2', 'limit=1&limit=2', 'view=metadata&view=content', 'foo=1']) {
    assert.equal(codeOf(() => parseEventsQuery(query)).code, 'INVALID_INPUT', query);
  }
  assert.equal(codeOf(() => parseEventsQuery('x=' + 'a'.repeat(MAX_QUERY_CHARS))).code, 'QUERY_TOO_LARGE');
  assert.equal(codeOf(() => parseEventsQuery('x=' + 'a'.repeat(MAX_QUERY_CHARS))).status, 414);
});

test('status query rejects every parameter', () => {
  assert.doesNotThrow(() => parseStatusQuery(''));
  assert.equal(codeOf(() => parseStatusQuery('project_id=demo')).code, 'INVALID_INPUT');
  assert.equal(codeOf(() => parseStatusQuery('after=1')).code, 'INVALID_INPUT');
  assert.equal(codeOf(() => parseStatusQuery('x=' + 'a'.repeat(MAX_QUERY_CHARS))).code, 'QUERY_TOO_LARGE');
});

test('request authorization requires loopback Host/Origin and a configured bearer token', () => {
  for (const host of ['127.0.0.1:8766', 'localhost:8766', '[::1]:8766']) {
    assert.equal(authorizeRequest({ host, authorization: statsAuthorization }, auth).id, 'agent-stats');
  }
  assert.equal(authorizeRequest({ host: '127.0.0.1:8766', origin: 'http://127.0.0.1:8766', authorization: knowledgeAuthorization }, auth).id, 'agent-knowledge');
  assert.equal(authorizeRequest({ host: 'localhost:8766', origin: 'http://localhost:8766', authorization: statsAuthorization }, auth).id, 'agent-stats');
  assert.equal(codeOf(() => authorizeRequest({ authorization: statsAuthorization }, auth)).code, 'INVALID_HOST');
  assert.equal(codeOf(() => authorizeRequest({ host: 'example.com:8766', authorization: statsAuthorization }, auth)).code, 'INVALID_HOST');
  assert.equal(codeOf(() => authorizeRequest({ host: '127.0.0.1:9999', authorization: statsAuthorization }, auth)).code, 'INVALID_HOST');
  assert.equal(codeOf(() => authorizeRequest({ host: ['127.0.0.1:8766', 'evil:8766'], authorization: statsAuthorization }, auth)).code, 'INVALID_HEADER');
  assert.equal(codeOf(() => authorizeRequest({ host: '127.0.0.1:8766', origin: 'http://evil.example:8766', authorization: statsAuthorization }, auth)).code, 'INVALID_ORIGIN');
  assert.equal(codeOf(() => authorizeRequest({ host: '127.0.0.1:8766', origin: 'null', authorization: statsAuthorization }, auth)).code, 'INVALID_ORIGIN');
  assert.equal(codeOf(() => authorizeRequest({ host: '127.0.0.1:8766' }, auth)).code, 'UNAUTHORIZED');
  assert.equal(codeOf(() => authorizeRequest({ host: '127.0.0.1:8766', authorization: 'Basic abc' }, auth)).code, 'UNAUTHORIZED');
  assert.equal(codeOf(() => authorizeRequest({ host: '127.0.0.1:8766', authorization: 'Bearer' }, auth)).code, 'UNAUTHORIZED');
  assert.equal(codeOf(() => authorizeRequest({ host: '127.0.0.1:8766', authorization: 'Bearer wrong-token' }, auth)).code, 'UNAUTHORIZED');
  assert.equal(codeOf(() => authorizeRequest({ host: '127.0.0.1:8766', authorization: [statsAuthorization, knowledgeAuthorization] }, auth)).code, 'INVALID_HEADER');
});

test('view authorization and error mapping are explicit', () => {
  const stats = authorizeRequest({ host: '127.0.0.1:8766', authorization: statsAuthorization }, auth);
  const knowledge = authorizeRequest({ host: '127.0.0.1:8766', authorization: knowledgeAuthorization }, auth);
  assert.doesNotThrow(() => authorizeView(stats, 'metadata'));
  assert.equal(codeOf(() => authorizeView(stats, 'content')).code, 'FORBIDDEN_VIEW');
  assert.doesNotThrow(() => authorizeView(knowledge, 'content'));
  assert.equal(codeOf(() => authorizeView(knowledge, 'metadata')).code, 'FORBIDDEN_VIEW');

  const invalidCursor = errorResponse(new ArchiveError('INVALID_CURSOR', 'Cursor is beyond archive history'));
  assert.deepEqual(invalidCursor, { status: 400, body: apiErrorBody('INVALID_CURSOR', 'Cursor is beyond archive history') });
  const invalidInput = errorResponse(new ArchiveError('INVALID_INPUT', 'bad limit'));
  assert.equal(invalidInput.status, 400);
  const internal = errorResponse(new ArchiveError('SOURCE_CONFLICT', 'sensitive internal detail'));
  assert.deepEqual(internal, { status: 500, body: apiErrorBody('INTERNAL', 'Archive request failed') });
  assert.deepEqual(errorResponse(new Error('boom')), { status: 500, body: apiErrorBody('INTERNAL', 'Internal server error') });
  for (const [code, status] of [['INVALID_INPUT', 400], ['UNAUTHORIZED', 401], ['FORBIDDEN_VIEW', 403], ['NOT_FOUND', 404], ['METHOD_NOT_ALLOWED', 405], ['PAGE_TOO_LARGE', 413], ['QUERY_TOO_LARGE', 414], ['OTHER', 500]] as const) {
    assert.equal(httpStatusFor(code), status);
  }
  assert.equal(httpStatusFor('INVALID_HOST'), 403);
  assert.equal(httpStatusFor('INVALID_ORIGIN'), 403);
});

test('status envelope exposes identity, watermark and collection health without credentials', () => {
  const status = buildApiStatus(
    { archive_id: 'archive-uuid', capture_mode: 'metadata', high_watermark: 42 },
    {
      enabled: true,
      state: 'idle',
      started_at: '2026-11-14T00:00:00.000Z',
      heartbeat_at: '2026-11-14T00:01:00.000Z',
      scan_interval_seconds: 30,
      last_scan_started_at: '2026-11-14T00:00:30.000Z',
      last_scan_finished_at: '2026-11-14T00:00:31.000Z',
      last_scan: { files: 2, imported: 3, skipped: 4, pending: 1, unmatched_projects: 1, errors: 0 },
      last_error: null,
      sources: [{ instance_id: 'device', root: '/logs/codex', project_ids: ['demo'], last_scan_at: '2026-11-14T00:00:31.000Z', last_error: null }],
    },
  );
  assert.equal(status.schema_version, 1);
  assert.deepEqual(status.archive, { archive_id: 'archive-uuid', capture_mode: 'metadata', high_watermark: 42 });
  assert.equal(status.protocol.default_page_events, DEFAULT_PAGE_EVENTS);
  assert.equal(status.protocol.max_page_events, MAX_PAGE_EVENTS);
  assert.deepEqual(status.protocol.views, ['metadata', 'content']);
  assert.equal(status.collection.state, 'idle');
  assert.equal(status.collection.last_scan!.unmatched_projects, 1);
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, new RegExp(hashToken(STATS_TOKEN)));
  assert.doesNotMatch(serialized, new RegExp(STATS_TOKEN));
});
