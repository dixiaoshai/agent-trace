import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { decodeZstdSource } from '../src/dsh.ts';
import { detectRuntime } from '../src/pi.ts';
import { Archive, sourceFiles } from '../src/store.ts';
import type { Event } from '../src/types.ts';

const CREATED = Date.parse('2026-01-01T10:00:00.000Z');
const at = (second: number): number => CREATED + second * 1000;

function rows(): unknown[] {
  return [
    {
      type: 'session', version: 4, id: 'session-demo', createdAt: CREATED,
      cwd: '/tmp/dsh-project', isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
    },
    { type: 'permission/preset', seq: 0, time: at(1), data: { preset: 'workspace-write' } },
    { type: 'turn/start', seq: 1, time: at(1), data: { turn: 1 } },
    {
      type: 'user/message', seq: 2, time: at(1),
      data: {
        content: [{ type: 'text', text: 'Hello\nworld' }], role: 'user',
        source: { kind: 'user', rpcId: 'rpc-1' }, id: 'user-1',
      },
      surfaceOp: 'append',
    },
    {
      type: 'system/message', seq: 3, time: at(1),
      data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'Hidden prompt' }], source: { kind: 'system-prompt' }, id: 'system-1' } },
      surfaceOp: 'append',
    },
    { type: 'request/context', seq: 4, time: at(1), data: { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 1048576 } },
    {
      type: 'assistant/message', seq: 5, time: at(2),
      data: {
        turn: 1, step: 1,
        message: {
          role: 'assistant', id: 'assistant-1',
          content: [
            { type: 'reasoning', text: 'Thinking about it' },
            { type: 'text', text: 'Running it' },
            { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
          ],
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
        },
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 2, reasoningTokens: 5, totalTokens: 170 },
      },
      surfaceOp: 'append',
    },
    { type: 'tool/call', seq: 6, time: at(2), data: { turn: 1, step: 1, callId: 'call_1', name: 'bash', arguments: '{"command":"ls"}' } },
    {
      type: 'tool/result', seq: 7, time: at(3),
      data: {
        turn: 1, step: 1,
        message: {
          role: 'tool', id: 'result-1', toolCallId: 'call_1', isError: false,
          content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: 'call_1' },
        },
        meta: { cwd: '/tmp/dsh-project' },
      },
      sourceEventSeqs: [6], surfaceOp: 'append',
    },
    { type: 'turn/end', seq: 8, time: at(4), data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/title', seq: 9, time: at(4), data: { title: 'Dsh demo', messageSeqs: [2], source: { kind: 'fallback' } } },
    { type: 'assistant/chunk', seq: 10, time: at(4), data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Running' } } },
  ];
}

/** A real dsh subagent header carries `origin: "subagent"` and `parentSession`. */
function subagentRows(): unknown[] {
  return [
    {
      type: 'session', version: 4, id: 'session-child', createdAt: CREATED,
      cwd: '/tmp/dsh-project', parentSession: 'session-parent', isSeeded: false,
      origin: 'subagent', delegationDepth: 1, agentPreset: 'standard',
    },
    { type: 'turn/start', seq: 0, time: at(1), data: { turn: 1 } },
    {
      type: 'user/message', seq: 1, time: at(1),
      data: {
        content: [{ type: 'text', text: 'Sub task' }], role: 'user',
        source: { kind: 'user', rpcId: 'rpc-2' }, id: 'child-user',
      },
    },
    {
      type: 'assistant/message', seq: 2, time: at(2),
      data: {
        turn: 1, step: 1,
        message: {
          role: 'assistant', id: 'child-assistant',
          content: [{ type: 'text', text: 'Child answer' }],
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
        },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    },
    { type: 'tool/call', seq: 3, time: at(2), data: { turn: 1, step: 1, callId: 'call_child', name: 'bash', arguments: '{"command":"pwd"}' } },
    {
      type: 'tool/result', seq: 4, time: at(3),
      data: {
        turn: 1, step: 1,
        message: {
          role: 'tool', id: 'child-result', toolCallId: 'call_child', isError: false,
          content: [{ type: 'text', text: '/tmp/dsh-project' }], source: { kind: 'tool', callId: 'call_child' },
        },
      },
    },
    { type: 'turn/end', seq: 5, time: at(4), data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}

/** A seeded session copies the parent log's prefix before its own work starts. */
function seededRows(): unknown[] {
  return [
    {
      type: 'session', version: 4, id: 'session-child', createdAt: CREATED,
      cwd: '/tmp/dsh-project', parentSession: 'session-parent', isSeeded: true,
      delegationDepth: 1, agentPreset: 'standard',
    },
    // Inherited prefix: these records already exist in the parent session log.
    { type: 'permission/preset', seq: 0, time: at(1), data: { preset: 'workspace-write' } },
    { type: 'turn/start', seq: 1, time: at(1), data: { turn: 1 } },
    {
      type: 'user/message', seq: 2, time: at(1),
      data: {
        content: [{ type: 'text', text: 'Inherited prompt' }], role: 'user',
        source: { kind: 'user' }, id: 'inherited-user',
      },
    },
    {
      type: 'assistant/message', seq: 3, time: at(2),
      data: {
        turn: 1, step: 1,
        message: {
          role: 'assistant', id: 'inherited-assistant',
          content: [{ type: 'text', text: 'Inherited answer' }],
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
        },
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      },
    },
    { type: 'turn/end', seq: 4, time: at(3), data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/end-seed', seq: 5, time: at(3), data: { inherited: true } },
    // The child's own work starts after the marker.
    { type: 'subagent/descriptor', seq: 6, time: at(4), data: { name: 'worker' } },
    { type: 'turn/start', seq: 7, time: at(4), data: { turn: 2 } },
    {
      type: 'user/message', seq: 8, time: at(4),
      data: {
        content: [{ type: 'text', text: 'Own prompt' }], role: 'user',
        source: { kind: 'user' }, id: 'own-user',
      },
    },
    { type: 'turn/end', seq: 9, time: at(5), data: { turn: 2, reason: { kind: 'completed' } } },
  ];
}

/** One frame for the header plus one frame for the durable event batch. */
function encodeRows(items: unknown[], compact = false): Buffer {
  const encode = (part: unknown[]): Buffer => zstdCompressSync(part.map(row => JSON.stringify(row)).join('\n') + '\n');
  return Buffer.concat(compact ? [encode(items)] : [encode(items.slice(0, 1)), encode(items.slice(1))]);
}

function fixtureBytes(compact = false): Buffer {
  return encodeRows(rows(), compact);
}

function setup(t: test.TestContext, capture: 'metadata' | 'content' = 'content', bytes = fixtureBytes()) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-trace-dsh-'));
  const filename = path.join(dir, 'session.v4.jsonl.zstd');
  writeFileSync(filename, bytes);
  const archive = new Archive(path.join(dir, 'archive.sqlite'), capture);
  t.after(() => { archive.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, filename, archive };
}

/** Import a fixture through the archive and return its normalized v1 events. */
function importRows(t: test.TestContext, items: unknown[]): Event[] {
  const { filename, archive } = setup(t, 'metadata', encodeRows(items));
  archive.importFile(filename, 'device-a', 'demo');
  return archive.exportBatch(0, 100, 'metadata').events;
}

test('dsh sessions decode concatenated zstd frames and normalize to v1 events', t => {
  const { filename, archive } = setup(t);
  const decoded = decodeZstdSource(readFileSync(filename));
  assert.equal(decoded.pending, false);
  assert.equal(detectRuntime(decoded.text), 'dsh');

  const imported = archive.importFile(filename, 'device-a', cwd => {
    assert.equal(cwd, '/tmp/dsh-project');
    return 'demo';
  });
  assert.equal(imported.imported, 14);
  assert.equal(imported.pending, false);

  const events = archive.exportBatch(0, 100, 'metadata').events;
  assert.ok(events.every(event => event.runtime === 'dsh' && event.body === null && event.raw === null));
  assert.deepEqual(events.map(event => event.kind), [
    'session.started',
    'source.unknown',
    'turn.started',
    'message.user',
    'source.unknown',
    'source.unknown',
    'message.assistant',
    'reasoning.summary',
    'usage.snapshot',
    'tool.called',
    'tool.returned',
    'turn.completed',
    'source.unknown',
    'source.unknown',
  ]);
  assert.equal(events[0]!.data.cwd, '/tmp/dsh-project');
  assert.equal(events[0]!.data.created_at, '2026-01-01T10:00:00.000Z');
  assert.equal(events[0]!.data.title, 'Dsh demo');
  // A plain session carries neither `origin` nor `parentSession`.
  assert.equal(events[0]!.data.parent_session_id, null);
  assert.equal(events[0]!.data.forked_from_session_id, null);

  const user = events.find(event => event.kind === 'message.user')!;
  assert.equal(user.data.turn_id, '1');
  assert.equal(user.data.title, 'Hello world');

  const assistant = events.find(event => event.kind === 'message.assistant')!;
  assert.equal(assistant.data.model, 'deepseek-flash');
  assert.equal(assistant.body, null);
  const reasoning = events.find(event => event.kind === 'reasoning.summary')!;
  assert.equal(reasoning.data.available, true);

  const usage = events.find(event => event.kind === 'usage.snapshot')!;
  assert.deepEqual(usage.data, {
    turn_id: '1', root_turn_id: null, model: 'deepseek-flash',
    cumulative: {
      input_tokens: 150, cached_input_tokens: 50, cache_write_input_tokens: 2,
      output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 170,
    },
    last_usage: {
      input_tokens: 150, cached_input_tokens: 50, cache_write_input_tokens: 2,
      output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 170,
    },
    rate_limit_only: false,
  });

  const call = events.find(event => event.kind === 'tool.called')!;
  assert.equal(call.data.call_id, 'call_1');
  assert.equal(call.data.name, 'bash');
  assert.equal(call.data.input_bytes, Buffer.byteLength('{"command":"ls"}'));
  const returned = events.find(event => event.kind === 'tool.returned')!;
  assert.equal(returned.data.call_id, 'call_1');
  assert.equal(returned.data.status, 'result_observed');
  assert.equal(events.find(event => event.kind === 'turn.completed')!.data.turn_id, '1');

  assert.equal(new Set(events.map(event => event.event_id)).size, events.length);
  const again = archive.importFile(filename, 'device-a', 'demo');
  assert.equal(again.imported, 0);
  assert.equal(again.skipped, 14);
});

test('dsh content capture keeps the original record while metadata hides it', t => {
  const content = setup(t, 'content');
  content.archive.importFile(content.filename, 'device-a', 'demo');
  const events = content.archive.exportBatch(0, 100, 'content').events;
  const user = events.find(event => event.kind === 'message.user')!;
  assert.deepEqual(user.body, { text: 'Hello\nworld' });
  assert.equal((user.raw as Record<string, unknown>).type, 'user/message');
  const returned = events.find(event => event.kind === 'tool.returned')!;
  assert.deepEqual(returned.body, { output: [{ type: 'text', text: 'ok' }] });

  const metadata = setup(t, 'metadata');
  metadata.archive.importFile(metadata.filename, 'device-a', 'demo');
  const hidden = metadata.archive.exportBatch(0, 100, 'metadata').events;
  assert.ok(hidden.every(event => event.body === null && event.raw === null));
  assert.doesNotMatch(JSON.stringify(hidden), /Thinking about it|Running it|Hidden prompt/);
});

test('dsh source discovery selects compressed session logs and reports a torn tail', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-trace-dsh-scan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, '--tmp-project--');
  const session = path.join(project, 'session-demo');
  mkdirSync(session, { recursive: true });
  const header = zstdCompressSync(JSON.stringify(rows()[0]) + '\n');
  const events = zstdCompressSync(rows().slice(1).map(row => JSON.stringify(row)).join('\n') + '\n');
  const filename = path.join(session, 'session.v4.jsonl.zstd');
  writeFileSync(filename, Buffer.concat([header, events.subarray(0, events.length - 5)]));
  const files = sourceFiles([dir]);
  assert.deepEqual(files, [filename]);
  const decoded = decodeZstdSource(readFileSync(filename));
  assert.equal(decoded.pending, true);
  assert.equal(decoded.text, JSON.stringify(rows()[0]) + '\n');
});

test('dsh subagent sessions are attributed to their parent instead of being forks', t => {
  const events = importRows(t, subagentRows());
  const start = events[0]!;
  assert.equal(start.kind, 'session.started');
  assert.equal(start.data.parent_session_id, 'session-parent');
  assert.equal(start.data.forked_from_session_id, null);
  assert.deepEqual(events.map(event => event.kind), [
    'session.started',
    'turn.started',
    'message.user',
    'message.assistant',
    'usage.snapshot',
    'tool.called',
    'tool.returned',
    'turn.completed',
  ]);
  assert.equal(events.find(event => event.kind === 'message.user')!.data.title, 'Sub task');
  assert.equal(events.find(event => event.kind === 'message.assistant')!.data.turn_id, '1');
  assert.equal(events.find(event => event.kind === 'tool.called')!.data.call_id, 'call_child');
  assert.equal(events.find(event => event.kind === 'tool.returned')!.data.call_id, 'call_child');
  assert.equal(new Set(events.map(event => event.event_id)).size, events.length);
});

test('dsh seeded sessions skip the inherited prefix through the end-seed marker', t => {
  const events = importRows(t, seededRows());
  const start = events[0]!;
  assert.equal(start.kind, 'session.started');
  // `parentSession` on a non-subagent session is a historical fork source.
  assert.equal(start.data.parent_session_id, null);
  assert.equal(start.data.forked_from_session_id, 'session-parent');

  // Inherited records (lines 2-7, through the `session/end-seed` marker at line
  // 7) produce no events; only the child's own work after the marker does.
  assert.deepEqual(events.map(event => event.kind), [
    'session.started',
    'source.unknown',
    'turn.started',
    'message.user',
    'turn.completed',
  ]);
  assert.deepEqual(events.slice(1).map(event => event.native_type), [
    'subagent/descriptor',
    'turn/start',
    'user/message',
    'turn/end',
  ]);
  assert.ok(events.filter(event => event.kind !== 'session.started').every(event => event.source!.line >= 8));
  assert.equal(events.find(event => event.kind === 'message.user')!.data.title, 'Own prompt');
  assert.ok(!events.some(event => event.kind === 'usage.snapshot'));
  assert.ok(!events.some(event => event.kind === 'message.assistant'));
  assert.doesNotMatch(JSON.stringify(events.slice(1)), /Inherited/);
  assert.equal(new Set(events.map(event => event.event_id)).size, events.length);
});

test('dsh seeded subagent keeps its parent attribution and skips inherited work', t => {
  // The real-world combination: a continuable subagent inherits a parent-log
  // prefix and is still classified by `origin: "subagent"`.
  const items = seededRows();
  items[0] = { ...(items[0] as Record<string, unknown>), origin: 'subagent', delegationDepth: 1 };
  const events = importRows(t, items);
  assert.equal(events[0]!.data.parent_session_id, 'session-parent');
  assert.equal(events[0]!.data.forked_from_session_id, null);
  assert.deepEqual(events.map(event => event.kind), [
    'session.started',
    'source.unknown',
    'turn.started',
    'message.user',
    'turn.completed',
  ]);
  assert.ok(!events.some(event => event.kind === 'usage.snapshot'));
});
