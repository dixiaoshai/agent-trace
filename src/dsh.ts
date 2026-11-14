/**
 * DeepSeek Harness (`dsh`) session adapter.
 *
 * Dsh stores one session per directory under `~/.dsh/sessions/--<cwd>--/`.
 * Current logs are append-only JSONL files compressed as a concatenation of
 * independent Zstandard frames (`session.vN.jsonl.zstd`): one frame holds the
 * header line, later frames hold durable event batches. Each logical line is
 * one `SessionEvent` with a native `seq`; v4 is current, v0 is still readable
 * by the harness and shares the event vocabulary used here.
 *
 * The adapter maps the model-visible lifecycle to the same v1 envelope as the
 * Codex and pi adapters:
 *
 * - session header          -> session.started
 * - turn/start, turn/end    -> turn.started / turn.completed|interrupted
 * - user/message            -> message.user (direct human prompts only)
 * - assistant/message       -> message.assistant + reasoning.summary
 *                              + usage.snapshot
 * - tool/call, tool/result  -> tool.called / tool.returned
 * - compaction/summary      -> context.compacted (+ summarizer usage)
 * - anything else           -> source.unknown
 *
 * Dsh logs request-level TokenUsage in assistant messages: `inputTokens`
 * excludes cache reads, like pi. v1 defines input as including cached input.
 * Stream deltas (`assistant/chunk`, `*-chunks`) and inbox slices duplicate the
 * settled messages and stay raw evidence instead of creating extra turns.
 *
 * The optional header `origin: "subagent"` is the subagent classifier and its
 * `parentSession` becomes parent_session_id; forked sessions keep their
 * `parentSession` as forked_from_session_id. Seeded sessions start with an
 * inherited copy of the parent log, so records through the last
 * `session/end-seed` marker with `data.inherited === true` are not normalized
 * again under the child (they already exist under the parent session).
 */
import { zstdDecompressSync } from 'node:zlib';
import type { SourceRecord } from './codex.ts';
import {
  ArchiveError, hash, identifier, object, timestamp,
  type Event, type JsonObject, type RuntimeId, type View,
} from './types.ts';

export const DSH_RUNTIME: RuntimeId = 'dsh';
const ZSTD_MAGIC = 4247762216;
/** Bounds decompression even when a compressed source is small. */
export const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;

type Usage = { fields: JsonObject };

interface FrameRange { start: number; end: number }

const integer = (value: unknown): number | null =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;

function epoch(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function occurrence(row: JsonObject): string | null {
  return epoch(row.time) ?? epoch(row.createdAt) ?? timestamp(row.createdAt) ?? timestamp(row.timestamp);
}

const blocks = (value: unknown): JsonObject[] =>
  Array.isArray(value) ? value.map(object).filter((block): block is JsonObject => block !== null) : [];

const text = (value: unknown): string => typeof value === 'string' ? value : blocks(value)
  .filter(block => block.type === 'text' && typeof block.text === 'string')
  .map(block => block.text as string)
  .join('\n');

const reasoning = (value: unknown): string => typeof value === 'string' ? value : blocks(value)
  .filter(block => block.type === 'reasoning' && typeof block.text === 'string')
  .map(block => block.text as string)
  .join('\n');

const bytes = (value: unknown): number | null => typeof value === 'string'
  ? Buffer.byteLength(value)
  : value === undefined || value === null ? null : Buffer.byteLength(JSON.stringify(value));

function title(value: unknown): string | null {
  const cleaned = (typeof value === 'string' ? value : text(value)).replace(/\s+/g, ' ').trim();
  const chars = Array.from(cleaned);
  return chars.length > 80 ? chars.slice(0, 79).join('') + '…' : cleaned || null;
}

/** A dsh header is the only session record with a numeric format version and creation time. */
export function isDshHeader(row: JsonObject): boolean {
  return row.type === 'session' && typeof row.version === 'number' && typeof row.createdAt === 'number';
}

export function isZstdSource(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC;
}

/** Locate structurally complete frames without decompressing their blocks. */
function scanFrames(buffer: Buffer): { frames: FrameRange[]; tornStart?: number } {
  const frames: FrameRange[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new ArchiveError('INVALID_SOURCE', `Corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new ArchiveError('INVALID_SOURCE', `Corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < headerBytes) return { frames, tornStart: start };
    offset += headerBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new ArchiveError('INVALID_SOURCE', `Corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/**
 * Decode the concatenated-frame container used by dsh persistence. A torn
 * final frame contributes only complete decoded records and marks the source
 * pending, matching the harness's own crash-recovery read.
 */
export function decodeZstdSource(buffer: Buffer): { text: string; pending: boolean } {
  const { frames, tornStart } = scanFrames(buffer);
  const parts: Buffer[] = [];
  let total = 0;
  let needsSeparator = false;
  for (const frame of frames) {
    const remaining = MAX_DECOMPRESSED_BYTES - total;
    if (remaining <= 0) throw new ArchiveError('FILE_TOO_LARGE', 'Decoded source exceeds 256 MiB');
    let decoded: Buffer;
    try {
      decoded = zstdDecompressSync(buffer.subarray(frame.start, frame.end), { maxOutputLength: remaining });
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
        throw new ArchiveError('FILE_TOO_LARGE', 'Decoded source exceeds 256 MiB');
      }
      throw new ArchiveError('INVALID_SOURCE', `Corrupt Zstandard session log: ${error instanceof Error ? error.message : 'decompression failed'}`);
    }
    if (decoded.length) {
      if (needsSeparator) parts.push(Buffer.from('\n'));
      parts.push(decoded);
      total += decoded.length;
      needsSeparator = decoded[decoded.length - 1] !== 10;
    }
  }
  return {
    text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)),
    pending: tornStart !== undefined,
  };
}

export function parseRecords(input: string): { records: SourceRecord[]; pending: boolean } {
  const lines = input.split('\n');
  const tail = lines.pop()!;
  const records: SourceRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '');
    if (!line.trim()) continue;
    let row: JsonObject | null;
    try { row = object(JSON.parse(line)); } catch { row = null; }
    if (!row || typeof row.type !== 'string') {
      throw new ArchiveError('INVALID_RECORD', `Malformed complete dsh record at line ${i + 1}`);
    }
    records.push({ row, line: i + 1, record_hash: hash(line) });
  }
  return { records, pending: tail.length > 0 };
}

function header(records: SourceRecord[]): JsonObject {
  const value = records.find(record => record.row.type === 'session' && isDshHeader(record.row))?.row;
  if (!value) throw new ArchiveError('MISSING_SESSION', 'A complete dsh session header is required');
  return value;
}

export function sessionCwd(records: SourceRecord[]): unknown {
  return header(records).cwd;
}

function sessionTitle(records: SourceRecord[]): string | null {
  let named: string | null = null;
  for (const { row } of records) {
    if (row.type !== 'session/title') continue;
    const value = object(row.data)?.title;
    if (typeof value === 'string' && value.trim()) named = value;
  }
  if (named !== null) return title(named);
  for (const { row } of records) {
    if (row.type !== 'user/message') continue;
    const data = object(row.data);
    if (object(data?.source)?.kind !== 'user') continue;
    const prompt = title(data?.content);
    if (prompt !== null) return prompt;
  }
  return null;
}

/** Dsh TokenUsage counts are disjoint; v1 input includes cache reads. */
function mapUsage(value: unknown): Usage | null {
  const src = object(value);
  if (!src) return null;
  const input = integer(src.inputTokens);
  const cacheRead = integer(src.cacheReadTokens);
  const cacheWrite = integer(src.cacheWriteTokens);
  const output = integer(src.outputTokens);
  const reasoningTokens = integer(src.reasoningTokens);
  const total = integer(src.totalTokens);
  const fields: JsonObject = {};
  if (input !== null) fields.input_tokens = input + (cacheRead ?? 0);
  if (cacheRead !== null) fields.cached_input_tokens = cacheRead;
  if (cacheWrite !== null) fields.cache_write_input_tokens = cacheWrite;
  if (output !== null) fields.output_tokens = output;
  if (reasoningTokens !== null) fields.reasoning_output_tokens = reasoningTokens;
  if (total !== null) fields.total_tokens = total;
  else if (typeof fields.input_tokens === 'number' && typeof fields.output_tokens === 'number') {
    fields.total_tokens = fields.input_tokens + fields.output_tokens;
  }
  return Object.keys(fields).length ? { fields } : null;
}

function toolResult(data: JsonObject): { callId: string | null; content: unknown; isError: boolean } {
  const message = object(data.message);
  let content = message?.content ?? data.content ?? null;
  let isError = message?.isError === true || data.isError === true;
  let callId = typeof message?.toolCallId === 'string' && message.toolCallId
    ? message.toolCallId
    : typeof object(message?.source)?.callId === 'string' ? object(message?.source)!.callId as string : null;
  // v3 represented tool results as a user-role message with one wrapper block.
  const wrapper = blocks(message?.content)[0];
  if (wrapper?.type === 'tool-result') {
    callId = callId ?? (typeof wrapper.toolCallId === 'string' && wrapper.toolCallId ? wrapper.toolCallId : null);
    content = wrapper.content ?? [];
    isError = wrapper.isError === true || isError;
  }
  return { callId, content, isError };
}

export function normalize(
  records: SourceRecord[],
  sourcePath: string,
  instance: string,
  project: string,
  mode: View,
): Event[] {
  const head = header(records);
  const sessionId = identifier(head.id, 'session ID');
  const sessionKey = JSON.stringify([DSH_RUNTIME, instance, sessionId]);
  const createdAt = epoch(head.createdAt);
  // DSH header fields such as `cwd`, `parentSession`, `origin` and
  // `agentPreset` are optional. `origin` is the authoritative subagent
  // classifier (it is only ever "subagent"); `parentSession` alone does not
  // classify, because historical ordinary forks also retain it.
  const parentSession = typeof head.parentSession === 'string' && head.parentSession ? head.parentSession : null;
  const isSubagent = head.origin === 'subagent';
  const parentSessionId = isSubagent ? parentSession : null;
  // A subagent's `parentSession` is its direct creator, not a fork source.
  const forkedFrom = isSubagent ? null : parentSession;
  const displayTitle = sessionTitle(records);
  const observedAt = new Date().toISOString();
  // Current dsh logs separate tool/call from the settled assistant message. If
  // an older generation only embedded the call block, emit it once from here.
  const nativeCalls = new Set<string>();
  for (const { row } of records) {
    const callId = object(row.data)?.callId;
    if (row.type === 'tool/call' && typeof callId === 'string' && callId) nativeCalls.add(callId);
  }
  // A seeded session starts with a verbatim copy of the parent log's prefix.
  // The last `session/end-seed` record with `data.inherited === true` marks the
  // end of that inherited prefix; those records already exist under the parent
  // session, so normalizing them again would double-count the parent's work.
  let inheritedThrough = -1;
  if (head.isSeeded === true) {
    records.forEach((record, index) => {
      if (record.row.type !== 'session/end-seed') return;
      if (object(record.row.data)?.inherited === true) inheritedThrough = index;
    });
  }
  const events: Event[] = [];
  const cumulative: Record<string, number> = {};
  let model: string | null = null;
  let activeTurn: string | null = null;
  let started = false;

  const turnOf = (data: JsonObject | null): string | null => {
    const value = data?.turn;
    return Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : activeTurn;
  };

  const add = (
    record: SourceRecord,
    kind: string,
    identity: string,
    data: JsonObject,
    body: JsonObject | null,
    nativeType: string,
  ): void => {
    const sequence = Number.isSafeInteger(record.row.seq) && Number(record.row.seq) >= 0
      ? String(record.row.seq)
      : `line-${record.line}`;
    events.push({
      schema_version: 1,
      event_id: hash(JSON.stringify([DSH_RUNTIME, instance, sessionId, sequence, kind, identity])),
      archive_seq: 0,
      runtime: DSH_RUNTIME,
      instance_id: instance,
      session_id: sessionId,
      session_key: sessionKey,
      project_id: project,
      kind,
      occurred_at: occurrence(record.row),
      observed_at: observedAt,
      native_type: nativeType,
      source: { path: sourcePath, line: record.line, record_hash: record.record_hash },
      data,
      body: mode === 'content' ? body : null,
      raw: mode === 'content' ? record.row : null,
    });
  };

  const common = (turnId: string | null): JsonObject => ({
    turn_id: turnId,
    root_turn_id: null,
    model,
  });

  const addUsage = (record: SourceRecord, usage: Usage, turnId: string | null, nativeType: string): void => {
    for (const [key, value] of Object.entries(usage.fields)) {
      if (typeof value === 'number') cumulative[key] = (cumulative[key] ?? 0) + value;
    }
    add(record, 'usage.snapshot', '', {
      ...common(turnId),
      cumulative: { ...cumulative },
      last_usage: { ...usage.fields },
      rate_limit_only: false,
    }, null, nativeType);
  };

  for (const [index, record] of records.entries()) {
    const row = record.row;
    const data = object(row.data);

    if (row.type === 'session') {
      if (!isDshHeader(row) || started) continue;
      started = true;
      add(record, 'session.started', '', {
        ...common(null),
        cwd: typeof row.cwd === 'string' ? row.cwd : null,
        parent_session_id: parentSessionId,
        forked_from_session_id: forkedFrom,
        created_at: createdAt,
        cli_version: null,
        title: displayTitle,
      }, null, 'session');
      continue;
    }

    // The header always emits session.started above; inherited records were
    // copied from the parent log and must not be counted again under the child.
    if (index <= inheritedThrough) continue;

    if (row.type === 'turn/start') {
      activeTurn = turnOf(data);
      add(record, 'turn.started', '', common(activeTurn), null, 'turn/start');
      continue;
    }

    if (row.type === 'turn/end') {
      const target = turnOf(data);
      const reason = object(data?.reason)?.kind;
      add(record, reason === 'completed' ? 'turn.completed' : 'turn.interrupted', '', common(target), null, 'turn/end');
      if (target === activeTurn) activeTurn = null;
      continue;
    }

    if (row.type === 'request/context') {
      if (typeof data?.model === 'string' && data.model) model = data.model;
      add(record, 'source.unknown', '', common(activeTurn), null, 'request/context');
      continue;
    }

    if (row.type === 'request/header') {
      const configured = object(object(data?.header)?.config)?.model;
      if (typeof configured === 'string' && configured) model = configured;
      add(record, 'source.unknown', '', common(activeTurn), null, 'request/header');
      continue;
    }

    if (row.type === 'user/message') {
      if (object(data?.source)?.kind !== 'user') {
        add(record, 'source.unknown', '', common(activeTurn), null, 'user/message');
        continue;
      }
      const prompt = title(data?.content);
      add(record, 'message.user', '', {
        ...common(activeTurn),
        title: prompt,
      }, { text: text(data?.content) }, 'user/message');
      continue;
    }

    if (row.type === 'assistant/message') {
      const message = object(data?.message);
      const source = object(message?.source);
      const assistantModel = typeof source?.model === 'string' && source.model ? source.model : model;
      model = assistantModel;
      add(record, 'message.assistant', '', common(activeTurn), { text: text(message?.content) }, 'assistant/message');
      const visibleReasoning = reasoning(message?.content);
      if (visibleReasoning) {
        add(record, 'reasoning.summary', '', {
          ...common(activeTurn),
          available: true,
        }, { text: visibleReasoning }, 'assistant/message');
      }
      const usage = mapUsage(data?.usage);
      if (usage) addUsage(record, usage, turnOf(data), 'assistant/message');
      for (const block of blocks(message?.content)) {
        if (block.type !== 'tool-call') continue;
        const callId = typeof block.id === 'string' && block.id ? block.id : null;
        if (callId !== null && nativeCalls.has(callId)) continue;
        add(record, 'tool.called', callId ?? '', {
          ...common(turnOf(data)),
          call_id: callId,
          name: typeof block.name === 'string' && block.name ? block.name : 'tool',
          input_bytes: bytes(block.arguments),
        }, { arguments: block.arguments ?? null }, 'assistant/message');
      }
      continue;
    }

    if (row.type === 'tool/call') {
      const callId = typeof data?.callId === 'string' && data.callId ? data.callId : null;
      const name = typeof data?.name === 'string' && data.name ? data.name : 'tool';
      add(record, 'tool.called', callId ?? '', {
        ...common(turnOf(data)),
        call_id: callId,
        name,
        input_bytes: bytes(data?.arguments),
      }, { arguments: data?.arguments ?? null }, 'tool/call');
      continue;
    }

    if (row.type === 'tool/result') {
      const result = toolResult(data ?? {});
      add(record, 'tool.returned', result.callId ?? '', {
        ...common(turnOf(data)),
        call_id: result.callId,
        output_bytes: bytes(result.content),
        status: 'result_observed',
      }, { output: result.content }, 'tool/result');
      continue;
    }

    if (row.type === 'compaction/summary') {
      if (typeof data?.model === 'string' && data.model) model = data.model;
      const usage = mapUsage(data?.usage);
      if (usage) addUsage(record, usage, turnOf(data), 'compaction/summary');
      add(record, 'context.compacted', '', common(turnOf(data)), { text: text(data?.summary) }, 'compaction/summary');
      continue;
    }

    // Stream deltas, inbox slices, step boundaries, jobs, approvals, titles and
    // future event types stay visible as evidence without normalized kinds.
    add(record, 'source.unknown', '', common(activeTurn), null, String(row.type));
  }
  return events;
}
