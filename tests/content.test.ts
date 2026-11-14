import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Archive } from '../src/store.ts';
import { defaultBlobDirectory, isContentRef, redactLog, redactText, redactValue } from '../src/content.ts';
import { loadServiceConfig } from '../src/config.ts';
import type { Event } from '../src/types.ts';

// Synthetic credentials only; every value below is deliberately fake.
const OPENAI_KEY = 'sk-synthetic0000000000000000000000';
const GITHUB_TOKEN = 'ghp_synthetic000000000000000000000000';
const BEARER = 'Bearer synthetic-bearer-token-value';
const LARGE_SECRET = `before ${GITHUB_TOKEN} after `;
const LARGE_OUTPUT = `${LARGE_SECRET}${'x'.repeat(4096)}`;

function setup(t: test.TestContext, maxInline = 1024) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-trace-content-'));
  const sources = path.join(dir, 'sources');
  const blobs = path.join(dir, 'blobs');
  const db = path.join(dir, 'state', 'archive.sqlite');
  const source = path.join(sources, 'session.jsonl');
  mkdirSync(sources, { recursive: true });
  const records = [
    { timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: { id: 'content-session', cwd: '/synthetic/demo' } },
    { timestamp: '2026-01-01T00:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: `use ${OPENAI_KEY} please` } },
    {
      timestamp: '2026-01-01T00:00:02Z',
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{"password":"hunter2","note":"keep me"}' },
    },
    {
      timestamp: '2026-01-01T00:00:03Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call-1', output: LARGE_OUTPUT },
    },
    { timestamp: '2026-01-01T00:00:04Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: `done with ${BEARER}` } },
  ];
  writeFileSync(source, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  const archive = new Archive(db, 'content', { max_inline_bytes: maxInline, blob_directory: blobs });
  t.after(() => { archive.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, source, blobs, archive };
}

function eventOf(archive: Archive, kind: string): Event {
  const event = archive.exportBatch(0, 100, 'content').events.find(candidate => candidate.kind === kind);
  assert.ok(event, `missing ${kind} event`);
  return event;
}

function writeConfig(dir: string, value: Record<string, unknown>): string {
  const filename = path.join(dir, 'service.json');
  writeFileSync(filename, JSON.stringify(value));
  return filename;
}

test('content mode redacts credential shapes in body, raw and titles before storage', t => {
  const { source, archive } = setup(t);
  const report = archive.importFile(source, 'local', 'demo');
  assert.equal(report.imported, 5);

  const exported = JSON.stringify(archive.exportBatch(0, 100, 'content'));
  for (const secret of [OPENAI_KEY, GITHUB_TOKEN, 'synthetic-bearer-token-value', 'hunter2']) {
    assert.doesNotMatch(exported, new RegExp(secret), `captured content still contains ${secret}`);
  }
  assert.match(exported, /\[REDACTED:api_key\]/);
  assert.match(exported, /\[REDACTED:credential\]/);
  assert.match(exported, /\[REDACTED:secret\]/);

  const user = eventOf(archive, 'message.user');
  assert.equal(user.body!.text, 'use [REDACTED:api_key] please');
  assert.match(String(user.data.title), /\[REDACTED:api_key\]/);
  assert.doesNotMatch(JSON.stringify(user.raw), new RegExp(OPENAI_KEY));
  // The source assertion still refers to the original line, not the redacted copy.
  assert.equal(user.source!.record_hash, createHash('sha256').update(readFileSync(source, 'utf8').split('\n')[1]!).digest('hex'));

  const final = eventOf(archive, 'turn.completed');
  assert.equal(final.body!.text, 'done with [REDACTED:credential]');
});

test('oversized captures become verifiable blobs, are never truncated, and metadata stays empty', t => {
  const { source, blobs, archive } = setup(t);
  archive.importFile(source, 'local', 'demo');

  const returned = eventOf(archive, 'tool.returned');
  const ref = (returned.body as { output: unknown }).output;
  assert.ok(isContentRef(ref), 'large tool output should be a content reference');
  const pointer = ref.content_ref;
  assert.equal(path.dirname(pointer.path), path.resolve(blobs));
  assert.equal(pointer.media_type, 'text/plain');
  const stored = readFileSync(pointer.path, 'utf8');
  assert.equal(Buffer.byteLength(stored), pointer.bytes);
  assert.equal(createHash('sha256').update(stored).digest('hex'), pointer.sha256);
  assert.doesNotMatch(stored, new RegExp(GITHUB_TOKEN));
  assert.match(stored, /\[REDACTED:github_token\]/);
  assert.ok(stored.endsWith('x'.repeat(4096)), 'no silent truncation of the captured output');
  assert.equal(statSync(pointer.path).mode & 0o777, 0o600);
  assert.equal(statSync(blobs).mode & 0o777, 0o700);
  // raw is protected the same way, so content and raw stay consistent.
  const rawOutput = (returned.raw as unknown as { payload: { output: unknown } }).payload.output;
  assert.deepEqual(rawOutput, ref);

  const metadata = archive.exportBatch(0, 100, 'metadata');
  assert.ok(metadata.events.every(event => event.body === null && event.raw === null));
  assert.doesNotMatch(JSON.stringify(metadata), /content_ref|synthetic0000|synthetic-bearer|hunter2/);
  assert.match(JSON.stringify(metadata), /\[REDACTED:api_key\]/);

  // Reimporting the same source writes no duplicates and keeps one blob.
  const again = archive.importFile(source, 'local', 'demo');
  assert.equal(again.imported, 0);
  const reread = archive.readEvent(returned.event_id, 'content')!;
  assert.deepEqual((reread.body as { output: unknown }).output, ref);

  // A reconciled rewrite (changed timestamp, identical redacted body) must not
  // delete the blob the new revision still references.
  const lines = readFileSync(source, 'utf8').trimEnd().split('\n');
  const record = JSON.parse(lines[3]!) as { timestamp: string };
  record.timestamp = '2026-01-01T00:00:09Z';
  lines[3] = JSON.stringify(record);
  writeFileSync(source, `${lines.join('\n')}\n`);
  assert.equal(archive.importFile(source, 'local', 'demo').imported, 1);
  assert.ok(existsSync(pointer.path));
  assert.equal(readFileSync(pointer.path, 'utf8'), stored);
});

test('deleting a session removes its externalized content', t => {
  const { source, blobs, archive } = setup(t);
  archive.importFile(source, 'local', 'demo');
  const pointer = (eventOf(archive, 'tool.returned').body as { output: { content_ref: { path: string } } }).output.content_ref;
  assert.ok(existsSync(pointer.path));
  assert.deepEqual(archive.deleteSession('codex', 'local', 'content-session').deleted, true);
  assert.equal(existsSync(pointer.path), false);
  assert.equal(archive.exportBatch(0, 100, 'content').events.filter(event => event.kind !== 'session.deleted').length, 0);
});

test('redaction helpers cover common secret forms without breaking ordinary text', () => {
  assert.equal(redactText(`token=${OPENAI_KEY}`), 'token=[REDACTED:api_key]');
  assert.equal(redactText('Authorization: Bearer abcdefghijklmnop'), 'Authorization: [REDACTED:credential]');
  assert.equal(redactText('postgres://user:pa55w0rd@example.test/db'), 'postgres://[REDACTED:userinfo]@example.test/db');
  assert.equal(redactText('password: "correct horse battery staple"'), 'password: "[REDACTED:secret]"');
  assert.equal(redactText('{"password":"hunter2","note":"keep"}'), '{"password":"[REDACTED:secret]","note":"keep"}');
  assert.equal(redactText('token_count: 42'), 'token_count: 42');
  assert.equal(redactText('max_tokens=1000'), 'max_tokens=1000');
  assert.equal(redactText('const key = apiKeyOf(user)'), 'const key = apiKeyOf(user)');
  assert.equal(redactText(''), '');
  assert.deepEqual(redactValue({ a: [`${OPENAI_KEY}`], b: 1 }), { a: ['[REDACTED:api_key]'], b: 1 });
  assert.deepEqual(redactLog({ message: `failed with ${OPENAI_KEY}` }), { message: 'failed with [REDACTED:api_key]' });
  assert.deepEqual(
    redactValue({ password: 'hunter2', nested: { GITHUB_TOKEN: 'short' }, max_tokens: 10, token_count: 3 }),
    { password: '[REDACTED:secret]', nested: { GITHUB_TOKEN: '[REDACTED:secret]' }, max_tokens: 10, token_count: 3 },
  );
  // Redaction is stable if it runs twice (markers do not grow).
  assert.equal(redactText(redactText(`x ${OPENAI_KEY}`)), redactText(`x ${OPENAI_KEY}`));
  // Prose that merely starts with a scheme word is not a credential.
  assert.equal(redactText('basic instructions'), 'basic instructions');
  assert.equal(redactText('Basic authentication is supported'), 'Basic authentication is supported');
  assert.equal(redactText('digest algorithm'), 'digest algorithm');
  assert.equal(redactText('Token usage is billed'), 'Token usage is billed');
  assert.equal(redactText('80% fewer tokens: memory means your agent'), '80% fewer tokens: memory means your agent');
  assert.equal(redactText('"js-tokens": "^7.29.7",'), '"js-tokens": "^7.29.7",');
  // Placeholders and variable references are not secrets.
  assert.equal(redactText('Authorization: $OPENAI_API_KEY'), 'Authorization: $OPENAI_API_KEY');
  assert.equal(redactText('TOKEN=<your token>'), 'TOKEN=<your token>');
  assert.equal(redactText('token: {placeholder}'), 'token: {placeholder}');
  assert.equal(redactText('Basic category.'), 'Basic category.');
  assert.equal(redactText('Bearer --use-mock-keychain'), 'Bearer --use-mock-keychain');
  // Credential-shaped values stay redacted (a trailing sentence dot is consumed).
  assert.equal(redactText('Bearer smoke-token-123.'), '[REDACTED:credential]');
  // The explicit Authorization header form stays strict, even for word-like values.
  assert.equal(redactText('Authorization: Bearer instructions'), 'Authorization: [REDACTED:credential]');
  assert.equal(redactText('Authorization: Bearer smoke-token-123'), 'Authorization: [REDACTED:credential]');
  // Credential-shaped scheme values are still redacted, including pure mixed-case base64.
  assert.equal(redactText('Bearer dXNlcjpwYXNz'), '[REDACTED:credential]');
  assert.equal(redactText('curl -H "Authorization: Bearer synthetic-bearer-token-value"'), 'curl -H "Authorization: [REDACTED:credential]"');
  assert.equal(redactText('secret: 5f4dcc3b5aa765d61d8327deb882cf99'), 'secret: [REDACTED:secret]');
});

test('content configuration validates inline limits and resolves blob paths', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-trace-content-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = {
    schema_version: 1,
    database: 'state/trace-content.sqlite',
    capture_mode: 'content',
    collection: { enabled: false, sources: [] },
    api: { enabled: false },
  };
  const defaults = loadServiceConfig(writeConfig(dir, base));
  assert.equal(defaults.content.max_inline_bytes, 64 * 1024);
  assert.equal(defaults.content.blob_directory, path.join(dir, 'state', 'content-blobs'));
  assert.equal(defaultBlobDirectory(path.join(dir, 'state', 'trace-content.sqlite')), path.join(dir, 'state', 'content-blobs'));

  const explicit = loadServiceConfig(writeConfig(dir, { ...base, content: { max_inline_bytes: 2048, blob_directory: 'captured' } }));
  assert.equal(explicit.content.max_inline_bytes, 2048);
  assert.equal(explicit.content.blob_directory, path.join(dir, 'captured'));

  for (const invalid of [{ max_inline_bytes: 0 }, { max_inline_bytes: 1.5 }, { max_inline_bytes: 'big' }, { blob_directory: 3 }, { blob_directory: '~/blobs' }, { unknown: true }]) {
    assert.throws(() => loadServiceConfig(writeConfig(dir, { ...base, content: invalid })), /config\.content/);
  }
  assert.throws(
    () => loadServiceConfig(writeConfig(dir, { ...base, content: { max_inline_bytes: 9 * 1024 * 1024 } })),
    /config\.content\.max_inline_bytes/,
  );
});

test('discarded revisions and rejected imports leave no orphan blobs', t => {
  const { dir, source, blobs, archive } = setup(t);
  archive.importFile(source, 'local', 'demo');
  const filesAfterFirst = readdirSync(blobs);

  // Same session identity, older revision: the importer skips it, so the blobs
  // written while protecting the discarded payload must be removed again.
  const older = path.join(dir, 'sources', 'older.jsonl');
  const marker = `ORPHAN-${'z'.repeat(2048)}`;
  writeFileSync(older, `${[
    { timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: { id: 'content-session', cwd: '/synthetic/demo' } },
    { timestamp: '2026-01-01T00:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'discarded revision' } },
    {
      timestamp: '2026-01-01T00:00:02Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call-9', output: marker },
    },
  ].map(record => JSON.stringify(record)).join('\n')}\n`);
  assert.equal(archive.importFile(older, 'local', 'demo').imported, 0);
  assert.deepEqual(readdirSync(blobs).sort(), filesAfterFirst.sort());
  assert.equal(readdirSync(blobs).some(name => readFileSync(path.join(blobs, name), 'utf8').includes('ORPHAN-')), false);

  // A deleted session rejects re-import; protection runs first, so the write
  // must not survive the rejection either.
  archive.deleteSession('codex', 'local', 'content-session');
  const before = readdirSync(blobs);
  assert.throws(() => archive.importFile(older, 'local', 'demo'), /SESSION_DELETED|deleted/i);
  assert.deepEqual(readdirSync(blobs).sort(), before.sort());
});

test('gc removes only blob files no committed event cites', t => {
  const { source, blobs, archive } = setup(t);
  archive.importFile(source, 'local', 'demo');
  const referenced = readdirSync(blobs);
  assert.ok(referenced.length > 0);

  const orphan = path.join(blobs, `${'a'.repeat(64)}-${'b'.repeat(64)}.txt`);
  const unrelated = path.join(blobs, 'notes.txt');
  writeFileSync(orphan, 'orphan', { mode: 0o600 });
  writeFileSync(unrelated, 'keep me', { mode: 0o600 });

  const dry = archive.pruneOrphanBlobs({ dry_run: true });
  assert.equal(dry.orphans, 1);
  assert.equal(dry.removed, 0);
  assert.equal(dry.files, referenced.length + 1);
  assert.equal(dry.referenced, referenced.length);
  assert.ok(existsSync(orphan));

  const result = archive.pruneOrphanBlobs();
  assert.equal(result.orphans, 1);
  assert.equal(result.removed, 1);
  assert.equal(existsSync(orphan), false);
  assert.ok(existsSync(unrelated), 'non-blob files are never candidates');
  for (const name of referenced) assert.ok(existsSync(path.join(blobs, name)));

  const metadata = new Archive(path.join(path.dirname(path.dirname(blobs)), 'metadata.sqlite'), 'metadata');
  t.after(() => metadata.close());
  assert.throws(() => metadata.pruneOrphanBlobs(), /CAPTURE_MODE|content archive/i);
});
