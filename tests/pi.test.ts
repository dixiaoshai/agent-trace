import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Archive } from '../src/store.ts';
import { detectRuntime } from '../src/pi.ts';

function usage(input: number, output: number, cacheRead: number, reasoning: number, total: number, cost: number, provider = false) {
  return { input, output, cacheRead, cacheWrite: 0, reasoning, totalTokens: total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost, totalFromProvider: provider } };
}

function fixture(parentSession?: string): string {
  const rows: unknown[] = [
    { type: 'session', version: 3, id: 'pi-demo-session', timestamp: '2026-01-01T10:00:00.000Z', cwd: '/tmp/pi-project', ...(parentSession ? { parentSession } : {}) },
    { type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-01-01T10:00:00.500Z', provider: 'deepseek', modelId: 'deepseek-flash' },
    { type: 'message', id: 'u1', parentId: 'm1', timestamp: '2026-01-01T10:00:01.000Z', message: { role: 'user', content: 'Hello\nworld', timestamp: 1767261601000 } },
    {
      type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T10:00:02.000Z',
      message: {
        role: 'assistant', provider: 'deepseek', model: 'deepseek-flash', api: 'openai-completions',
        content: [
          { type: 'text', text: 'Running it' },
          { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
        ],
        usage: usage(100, 20, 50, 5, 170, 0.001), stopReason: 'toolUse', timestamp: 1767261602000,
      },
    },
    { type: 'message', id: 'tr1', parentId: 'a1', timestamp: '2026-01-01T10:00:03.000Z', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 1767261603000 } },
    {
      type: 'message', id: 'a2', parentId: 'tr1', timestamp: '2026-01-01T10:00:04.000Z',
      message: {
        role: 'assistant', provider: 'deepseek', model: 'deepseek-flash', api: 'openai-completions',
        content: [{ type: 'text', text: 'Done' }], usage: usage(200, 30, 10, 0, 240, 0.002, true), stopReason: 'stop', timestamp: 1767261604000,
      },
    },
    { type: 'session_info', id: 's1', parentId: 'a2', timestamp: '2026-01-01T10:00:05.000Z', name: 'Pi demo' },
  ];
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
}

function setup(t: test.TestContext, text = fixture(), capture: 'metadata' | 'content' = 'content') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-trace-pi-'));
  const filename = path.join(dir, 'session.jsonl');
  writeFileSync(filename, text);
  const archive = new Archive(path.join(dir, 'archive.sqlite'), capture);
  t.after(() => { archive.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, filename, archive };
}

test('pi sessions normalize to v1 turns, usage and tools', t => {
  const { filename, archive } = setup(t);
  assert.equal(detectRuntime(readFileSync(filename, 'utf8')), 'pi');
  const imported = archive.importFile(filename, 'device-a', cwd => {
    assert.equal(cwd, '/tmp/pi-project');
    return 'demo';
  });
  assert.equal(imported.imported, 12);
  const events = archive.exportBatch(0, 100, 'metadata').events;
  assert.ok(events.every(event => event.runtime === 'pi'));
  assert.equal(events[0]!.kind, 'session.started');
  assert.deepEqual(events[0]!.data, {
    turn_id: null, root_turn_id: null, model: null, cwd: '/tmp/pi-project',
    parent_session_id: null, forked_from_session_id: null,
    created_at: '2026-01-01T10:00:00.000Z', cli_version: null, title: 'Pi demo',
  });

  const user = events.find(event => event.kind === 'message.user')!;
  assert.equal(user.data.title, 'Hello world');
  assert.equal(user.data.turn_id, 'u1');
  assert.equal(events.find(event => event.kind === 'turn.started')!.data.turn_id, 'u1');

  const usageEvents = events.filter(event => event.kind === 'usage.snapshot');
  assert.equal(usageEvents.length, 2);
  assert.deepEqual(usageEvents[0]!.data, {
    turn_id: 'u1', root_turn_id: null, model: 'deepseek-flash',
    cumulative: { input_tokens: 150, cached_input_tokens: 50, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 170 },
    last_usage: { input_tokens: 150, cached_input_tokens: 50, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 170 },
    rate_limit_only: false, cost_usd: 0.001, cost_source: 'model_rates',
  });
  // Pi's input excludes cache reads; v1 input includes them.
  assert.deepEqual(usageEvents[1]!.data.last_usage, {
    input_tokens: 210, cached_input_tokens: 10, cache_write_input_tokens: 0,
    output_tokens: 30, reasoning_output_tokens: 0, total_tokens: 240,
  });
  assert.deepEqual(usageEvents[1]!.data.cumulative, {
    input_tokens: 360, cached_input_tokens: 60, cache_write_input_tokens: 0,
    output_tokens: 50, reasoning_output_tokens: 5, total_tokens: 410,
  });
  assert.equal(usageEvents[1]!.data.cost_usd, 0.002);
  assert.equal(usageEvents[1]!.data.cost_source, 'provider');

  const call = events.find(event => event.kind === 'tool.called')!;
  assert.equal(call.data.call_id, 'call_1');
  assert.equal(call.data.name, 'bash');
  assert.equal(typeof call.data.input_bytes, 'number');
  const returned = events.find(event => event.kind === 'tool.returned')!;
  assert.equal(returned.data.call_id, 'call_1');
  assert.equal(returned.data.status, 'result_observed');
  assert.equal(events.find(event => event.kind === 'turn.completed')!.data.turn_id, 'u1');

  // Several events from one entry share the line but not the identity.
  assert.equal(new Set(events.map(event => event.event_id)).size, events.length);
  const line4 = events.filter(event => event.source!.line === 4);
  assert.deepEqual(line4.map(event => event.kind), ['message.assistant', 'usage.snapshot', 'tool.called']);

  // Reimport is idempotent; a moved copy keeps identity.
  const again = archive.importFile(filename, 'device-a', 'demo');
  assert.equal(again.imported, 0);
  assert.equal(again.skipped, 12);
  assert.equal(archive.exportBatch(0, 100).events.length, 12);
});

test('pi metadata hides message bodies while content keeps the original entry', t => {
  const metadata = setup(t, fixture(), 'metadata');
  metadata.archive.importFile(metadata.filename, 'device-a', 'demo');
  const metaEvents = metadata.archive.exportBatch(0, 100, 'metadata').events;
  assert.ok(metaEvents.every(event => event.body === null && event.raw === null));
  assert.doesNotMatch(JSON.stringify(metaEvents), /Running it|"ok"/);

  const content = setup(t);
  content.archive.importFile(content.filename, 'device-a', 'demo');
  const body = content.archive.exportBatch(0, 100, 'content').events;
  const assistant = body.find(event => event.kind === 'message.assistant')!;
  assert.deepEqual(assistant.body, { text: 'Running it' });
  assert.equal((assistant.raw as any).message.role, 'assistant');
  assert.equal(body.find(event => event.kind === 'message.user')!.body!.text, 'Hello\nworld');
});

test('pi fork header keeps the parent identity and start time', t => {
  const text = fixture('/home/user/.pi/agent/sessions/--tmp--/2026-01-01T09-00-00-000Z_parent-session.jsonl');
  const { filename, archive } = setup(t, text);
  archive.importFile(filename, 'device-a', 'demo');
  const start = archive.exportBatch(0, 100).events.find(event => event.kind === 'session.started')!;
  assert.equal(start.data.forked_from_session_id, 'parent-session');
  assert.equal(start.data.created_at, '2026-01-01T10:00:00.000Z');
});

test('pi runtime detection, incomplete tails and deletion', t => {
  const { filename, archive } = setup(t);
  const full = readFileSync(filename, 'utf8');
  const boundary = full.lastIndexOf('\n', full.length - 2) + 1;
  writeFileSync(filename, full.slice(0, boundary + 10));
  const partial = archive.importFile(filename, 'device-a', 'demo');
  assert.equal(partial.pending, true);
  assert.equal(partial.imported, 11);
  writeFileSync(filename, full);
  assert.equal(archive.importFile(filename, 'device-a', 'demo').imported, 1);

  assert.throws(() => archive.importFile(filename, 'device-a', 'demo', undefined, 'codex'), /pi session, but codex was selected/);
  assert.equal(archive.deleteSession('pi', 'device-a', 'pi-demo-session').deleted, true);
  assert.equal(archive.exportBatch(0, 100).events.at(-1)!.kind, 'session.deleted');
  assert.throws(() => archive.importFile(filename, 'device-a', 'demo'), /Deleted session/);
});

test('malformed pi records fail atomically', t => {
  const { dir, filename, archive } = setup(t, fixture() + '{broken}\n');
  const empty = path.join(dir, 'empty.jsonl');
  writeFileSync(empty, '');
  assert.deepEqual(archive.importFile(empty, 'device-a', 'demo'), { imported: 0, skipped: 0, pending: false });
  assert.throws(() => archive.importFile(filename, 'device-a', 'demo'), /Malformed complete pi record/);
  assert.equal(archive.exportBatch().events.length, 0);
  assert.throws(() => detectRuntime('{"type":"unrelated"}\n'), /Cannot determine source runtime/);
});
