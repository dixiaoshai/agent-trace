/**
 * Pi session adapter.
 *
 * Pi stores append-only JSONL sessions under `~/.pi/agent/sessions`. Unlike
 * Codex rollouts, entries are tree nodes with `id`/`parentId` and assistant
 * messages carry per-request usage (and the cost pi computed for that request).
 * This adapter maps one file to v1 events without inventing a second archive
 * format:
 *
 * - session header        -> session.started
 * - user message          -> message.user + turn.started
 * - assistant message     -> message.assistant + usage.snapshot + tool.called
 *                            (+ turn.completed / turn.interrupted)
 * - toolResult message    -> tool.returned
 * - compaction / usage    -> context.compacted / usage.snapshot
 * - anything else         -> source.unknown
 *
 * A turn is synthesized from the user entry id because pi has no native turn
 * id. Forked/cloned sessions copy the source entries verbatim; the header's
 * `timestamp` and `parentSession` let consumers skip inherited history, exactly
 * like Codex forks. Usage is reported per request, so the adapter also emits a
 * running cumulative snapshot: consumers that only know cumulative accounting
 * can still derive the same per-request delta.
 */
import type { SourceRecord } from './codex.ts';
import {
  ArchiveError, hash, identifier, object, timestamp,
  type Event, type JsonObject, type RuntimeId, type View,
} from './types.ts';

export const PI_RUNTIME: RuntimeId = 'pi';
const TERMINAL_STOP = new Set(['stop', 'length']);
const INTERRUPTED_STOP = new Set(['aborted', 'error']);

type Usage = { fields: JsonObject; cost: JsonObject | null };

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

/** Pi input excludes cache reads; v1 defines input as including cached input. */
function mapUsage(value: unknown): Usage | null {
  const src = object(value);
  if (!src) return null;
  const input = integer(src.input);
  const cacheRead = integer(src.cacheRead);
  const cacheWrite = integer(src.cacheWrite);
  const output = integer(src.output);
  const reasoning = integer(src.reasoning);
  const total = integer(src.totalTokens);
  const fields: JsonObject = {};
  if (input !== null) fields.input_tokens = input + (cacheRead ?? 0);
  if (cacheRead !== null) fields.cached_input_tokens = cacheRead;
  if (cacheWrite !== null) fields.cache_write_input_tokens = cacheWrite;
  if (output !== null) fields.output_tokens = output;
  if (reasoning !== null) fields.reasoning_output_tokens = reasoning;
  if (total !== null) fields.total_tokens = total;
  else if (typeof fields.input_tokens === 'number' && typeof fields.output_tokens === 'number') {
    fields.total_tokens = fields.input_tokens + fields.output_tokens;
  }
  if (!Object.keys(fields).length) return null;
  const cost = object(src.cost);
  const totalCost = cost && typeof cost.total === 'number' && Number.isFinite(cost.total) && cost.total >= 0
    ? cost.total
    : null;
  return {
    fields,
    cost: totalCost === null ? null : {
      cost_usd: totalCost,
      // OpenRouter-style BYOK responses report the provider's real charge.
      cost_source: cost!.totalFromProvider === true ? 'provider' : 'model_rates',
    },
  };
}

const text = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(part => {
    if (typeof part === 'string') return part;
    const block = object(part);
    return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
  }).filter(part => part !== '').join('\n');
};

const bytes = (value: unknown): number | null => typeof value === 'string'
  ? Buffer.byteLength(value)
  : value === undefined || value === null ? null : Buffer.byteLength(JSON.stringify(value));

function title(value: unknown): string | null {
  const cleaned = text(value).replace(/\s+/g, ' ').trim();
  const chars = Array.from(cleaned);
  return chars.length > 80 ? chars.slice(0, 79).join('') + '…' : cleaned || null;
}

/** Distinguish a pi session from a Codex rollout without reading the whole file. */
export function detectRuntime(input: string): RuntimeId {
  const first = input.split('\n').find(line => line.trim());
  if (!first) throw new ArchiveError('INVALID_RECORD', 'Source is empty');
  let row: JsonObject | null;
  try { row = object(JSON.parse(first.replace(/\r$/, ''))); } catch { row = null; }
  if (!row) throw new ArchiveError('INVALID_RECORD', 'Source does not start with a JSON object');
  if (row.type === 'session_meta') return 'codex';
  if (row.type === 'session' && typeof row.id === 'string') return 'pi';
  throw new ArchiveError('INVALID_RECORD', 'Cannot determine source runtime from the first record');
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
      throw new ArchiveError('INVALID_RECORD', `Malformed complete pi record at line ${i + 1}`);
    }
    records.push({ row, line: i + 1, record_hash: hash(line) });
  }
  return { records, pending: tail.length > 0 };
}

function header(records: SourceRecord[]): JsonObject {
  const value = records.find(record => record.row.type === 'session')?.row;
  if (!value) throw new ArchiveError('MISSING_SESSION', 'A complete pi session header is required');
  return value;
}

export function sessionCwd(records: SourceRecord[]): unknown {
  return header(records).cwd;
}

/** `.../2026-01-01T00-00-00-000Z_<session-id>.jsonl`; custom IDs are allowed. */
function parentSessionId(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const base = value.split(/[\\/]/).pop() ?? '';
  const name = base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
  const separator = name.indexOf('_');
  const candidate = separator >= 0 ? name.slice(separator + 1) : name;
  if (!candidate || candidate.length > 500 || /[\x00-\x1f]/.test(candidate)) return null;
  return candidate;
}

function sessionTitle(records: SourceRecord[]): string | null {
  let name: string | null = null;
  for (const { row } of records) {
    if (row.type !== 'session_info') continue;
    if (typeof row.name === 'string' && row.name.trim()) name = row.name;
  }
  if (name !== null) return title(name);
  // Unnamed sessions display like pi's own selector: the first user prompt.
  for (const { row } of records) {
    if (row.type !== 'message') continue;
    const message = object(row.message);
    if (message?.role !== 'user') continue;
    const prompt = title(message.content);
    if (prompt !== null) return prompt;
  }
  return null;
}

export function normalize(
  records: SourceRecord[],
  sourcePath: string,
  instance: string,
  project: string,
  mode: View,
): Event[] {
  const headerRecord = records.find(record => record.row.type === 'session');
  if (!headerRecord) throw new ArchiveError('MISSING_SESSION', 'A complete pi session header is required');
  const head = headerRecord.row;
  const sessionId = identifier(head.id, 'session ID');
  const sessionKey = JSON.stringify([PI_RUNTIME, instance, sessionId]);
  const createdAt = timestamp(head.timestamp);
  const forkedFrom = parentSessionId(head.parentSession);
  const displayTitle = sessionTitle(records);
  const observedAt = new Date().toISOString();
  const events: Event[] = [];
  const cumulative: Record<string, number> = {};
  let model: string | null = typeof head.model === 'string' ? head.model : null;
  let activeTurn: string | null = null;

  const entryId = (record: SourceRecord): string =>
    typeof record.row.id === 'string' && record.row.id ? record.row.id : `line-${record.line}`;

  const common = (turnId: string | null, atModel: string | null): JsonObject => ({
    turn_id: turnId,
    root_turn_id: null,
    model: atModel,
  });

  const add = (
    record: SourceRecord,
    kind: string,
    identity: string,
    data: JsonObject,
    body: JsonObject | null,
    nativeType: string,
  ): void => {
    events.push({
      schema_version: 1,
      // One entry can produce several events (usage + tool calls + turn end).
      // The entry id is stable across copies; the kind/call id disambiguates.
      event_id: hash(JSON.stringify([PI_RUNTIME, instance, sessionId, entryId(record), kind, identity])),
      archive_seq: 0,
      runtime: PI_RUNTIME,
      instance_id: instance,
      session_id: sessionId,
      session_key: sessionKey,
      project_id: project,
      kind,
      occurred_at: timestamp(record.row.timestamp),
      observed_at: observedAt,
      native_type: nativeType,
      source: { path: sourcePath, line: record.line, record_hash: record.record_hash },
      data,
      body: mode === 'content' ? body : null,
      raw: mode === 'content' ? record.row : null,
    });
  };

  const addUsage = (record: SourceRecord, usage: Usage, nativeType: string): void => {
    for (const [key, value] of Object.entries(usage.fields)) {
      if (typeof value === 'number') cumulative[key] = (cumulative[key] ?? 0) + value;
    }
    add(record, 'usage.snapshot', '', {
      ...common(activeTurn, model),
      cumulative: { ...cumulative },
      last_usage: { ...usage.fields },
      rate_limit_only: false,
      ...(usage.cost ?? {}),
    }, null, nativeType);
  };

  for (const record of records) {
    const row = record.row;
    if (row.type === 'session') {
      if (record !== headerRecord) continue;
      add(record, 'session.started', '', {
        ...common(null, null),
        cwd: typeof row.cwd === 'string' ? row.cwd : null,
        parent_session_id: null,
        forked_from_session_id: forkedFrom,
        created_at: createdAt,
        cli_version: null,
        title: displayTitle,
      }, null, 'session');
      continue;
    }

    if (row.type === 'model_change') {
      if (typeof row.modelId === 'string' && row.modelId) model = row.modelId;
      add(record, 'source.unknown', '', common(activeTurn, model), null, 'model_change');
      continue;
    }
    if (row.type === 'thinking_level_change') {
      add(record, 'source.unknown', '', common(activeTurn, model), null, 'thinking_level_change');
      continue;
    }

    if (row.type === 'message') {
      const message = object(row.message);
      if (!message) {
        add(record, 'source.unknown', '', common(activeTurn, model), null, 'message');
        continue;
      }
      const role = typeof message.role === 'string' ? message.role : '';
      if (role === 'user') {
        activeTurn = entryId(record);
        add(record, 'message.user', '', {
          ...common(activeTurn, model),
          title: title(message.content),
        }, { text: text(message.content) }, 'message.user');
        // A user entry opens the turn; every later event until a terminal
        // assistant stop belongs to it.
        add(record, 'turn.started', '', common(activeTurn, model), null, 'message.user');
        continue;
      }
      if (role === 'assistant') {
        const assistantModel = typeof message.model === 'string' && message.model ? message.model : model;
        model = assistantModel;
        add(record, 'message.assistant', '', common(activeTurn, assistantModel), { text: text(message.content) }, 'message.assistant');
        const usage = mapUsage(message.usage);
        if (usage) addUsage(record, usage, 'message.assistant');
        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            const block = object(part);
            if (block?.type !== 'toolCall') continue;
            const callId = typeof block.id === 'string' && block.id ? block.id : null;
            const name = typeof block.name === 'string' && block.name ? block.name : 'tool';
            add(record, 'tool.called', callId ?? '', {
              ...common(activeTurn, assistantModel),
              call_id: callId,
              name,
              input_bytes: bytes(block.arguments),
            }, { arguments: block.arguments ?? null }, 'message.assistant');
          }
        }
        const stop = typeof message.stopReason === 'string' ? message.stopReason : '';
        if (TERMINAL_STOP.has(stop)) {
          add(record, 'turn.completed', '', common(activeTurn, assistantModel), null, 'message.assistant');
          activeTurn = null;
        } else if (INTERRUPTED_STOP.has(stop)) {
          add(record, 'turn.interrupted', '', common(activeTurn, assistantModel), null, 'message.assistant');
          activeTurn = null;
        }
        continue;
      }
      if (role === 'toolResult') {
        const callId = typeof message.toolCallId === 'string' && message.toolCallId ? message.toolCallId : null;
        add(record, 'tool.returned', callId ?? '', {
          ...common(activeTurn, model),
          call_id: callId,
          output_bytes: bytes(message.content),
          status: 'result_observed',
        }, { output: message.content ?? null }, 'message.toolResult');
        continue;
      }
      add(record, 'source.unknown', '', common(activeTurn, model), null, `message.${role || 'unknown'}`);
      continue;
    }

    if (row.type === 'compaction') {
      const usage = mapUsage(row.usage);
      if (usage) addUsage(record, usage, 'compaction');
      add(record, 'context.compacted', '', common(activeTurn, model),
        { text: text(row.summary) }, 'compaction');
      continue;
    }
    if (row.type === 'branch_summary') {
      const usage = mapUsage(row.usage);
      if (usage) addUsage(record, usage, 'branch_summary');
      // There is no v1 branch-summary kind; retain the record as evidence.
      add(record, 'source.unknown', '', common(activeTurn, model), null, 'branch_summary');
      continue;
    }
    if (row.type === 'usage') {
      const usage = mapUsage(row.usage);
      if (usage) {
        if (typeof row.model === 'string' && row.model) model = row.model;
        addUsage(record, usage, 'usage');
      }
      continue;
    }

    // session_info, custom, custom_message, label, context_edit and future
    // entry types stay visible as evidence without becoming normalized kinds.
    add(record, 'source.unknown', '', common(activeTurn, model), null, String(row.type));
  }
  return events;
}
