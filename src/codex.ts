import type { TitleLookup } from './titles.ts';
import { ArchiveError, hash, identifier, object, timestamp, type Event, type JsonObject, type View } from './types.ts';

export const NORMALIZER_VERSION = 'codex-v1';
const USAGE_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
function usage(value: unknown): JsonObject {
  const src = object(value) ?? {};
  const out: JsonObject = {};
  for (const field of USAGE_FIELDS) if (Number.isSafeInteger(src[field]) && Number(src[field]) >= 0) out[field] = src[field];
  // The source's total convention includes input and output, not cached/reasoning twice.
  if (out.total_tokens === undefined && typeof out.input_tokens === 'number' && typeof out.output_tokens === 'number') out.total_tokens = out.input_tokens + out.output_tokens;
  return out;
}
const text = (v: unknown): string => typeof v === 'string' ? v : Array.isArray(v)
  ? v.map(part => typeof part === 'string' ? part : typeof object(part)?.text === 'string' ? object(part)!.text : '').join('\n') : '';
const bytes = (v: unknown): number | null => typeof v === 'string' ? Buffer.byteLength(v) : v !== undefined && v !== null ? Buffer.byteLength(JSON.stringify(v)) : null;

function title(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/# AGENTS\.md instructions\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '')
    .replace(/<(environment_context|external_codex_apps_open_page|turn_aborted|INSTRUCTIONS)>[\s\S]*?<\/\1>/g, '')
    .replace(/\s+/g, ' ').trim();
  const chars = Array.from(cleaned);
  return chars.length > 80 ? chars.slice(0, 79).join('') + '…' : cleaned || null;
}

export interface SourceRecord { row: JsonObject; line: number; record_hash: string }

/** Cwd of the identity the rollout finally belongs to (last session_meta). */
export function sessionCwd(records: SourceRecord[]): unknown {
  const metas = records.filter(record => record.row.type === 'session_meta');
  if (!metas.length) throw new ArchiveError('MISSING_SESSION', 'A complete session_meta identity is required');
  return object(metas[metas.length - 1]!.row.payload)?.cwd;
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
    if (!row || typeof row.type !== 'string' || !object(row.payload)) throw new ArchiveError('INVALID_RECORD', `Malformed complete Codex record at line ${i + 1}`);
    records.push({ row, line: i + 1, record_hash: hash(line) });
  }
  return { records, pending: tail.length > 0 };
}

export function normalize(
  records: SourceRecord[],
  sourcePath: string,
  instance: string,
  project: string,
  mode: View,
  titles?: TitleLookup,
): Event[] {
  const metas = records.filter(r => r.row.type === 'session_meta');
  if (!metas.length) throw new ArchiveError('MISSING_SESSION', 'A complete session_meta identity is required');
  // Codex appends another session_meta when a conversation is resumed, and
  // subagent rollouts repeat the parent identity after their own. The last
  // record is the identity the rollout finally belongs to, which is also what
  // the direct-import reader uses. Earlier identity records are resume markers,
  // not separate sessions; the rows they cover stay attributed to the final
  // identity so tokens never move between projects or duplicate a session.
  const finalMeta = metas[metas.length - 1]!;
  const sessionId = identifier(
    object(finalMeta.row.payload)!.id ?? object(finalMeta.row.payload)!.session_id,
    'session ID',
  );
  // A file folded into a shared session still needs a stable per-file
  // discriminator: two rollouts of the same session reuse line numbers but hold
  // different records, so (session, line) alone would collide. The first
  // identity is stable inside the file and moves with it. Single-identity logs
  // keep the plain v1 tuple, so their identifiers never change.
  const firstIdentity = object(metas[0]!.row.payload)!.id ?? object(metas[0]!.row.payload)!.session_id;
  const series = typeof firstIdentity === 'string' && firstIdentity && firstIdentity !== sessionId
    ? identifier(firstIdentity, 'session ID')
    : null;
  const sessionKey = JSON.stringify(['codex', instance, sessionId]);
  const sessionTitle = title(titles?.(sessionId));
  const observedAt = new Date().toISOString();
  const selected = metas.length === 1 ? records : records.filter(record => record.row.type !== 'session_meta' || record === finalMeta);
  return selected.map(({ row, line, record_hash }) => {
    const p = object(row.payload)!;
    const data: JsonObject = {
      turn_id: typeof p.turn_id === 'string' ? p.turn_id : null,
      root_turn_id: typeof p.root_turn_id === 'string' ? p.root_turn_id : null,
      model: typeof p.model === 'string' ? p.model : null,
    };
    let kind = 'source.unknown';
    let body: JsonObject | null = null;
    const subtype = typeof p.type === 'string' ? p.type : '';
    if (row.type === 'session_meta') {
      const spawn = object(object(object(p.source)?.subagent)?.thread_spawn);
      kind = 'session.started';
      Object.assign(data, {
        cwd: typeof p.cwd === 'string' ? p.cwd : null,
        parent_session_id: typeof spawn?.parent_thread_id === 'string' ? spawn.parent_thread_id : typeof p.parent_id === 'string' ? p.parent_id : null,
        forked_from_session_id: typeof p.forked_from_id === 'string' ? p.forked_from_id : null,
        created_at: timestamp(p.timestamp) ?? timestamp(row.timestamp),
        cli_version: typeof p.cli_version === 'string' ? p.cli_version : null,
        title: sessionTitle,
      });
    } else if (row.type === 'turn_context') kind = 'turn.context';
    else if (row.type === 'event_msg') {
      if (subtype === 'task_started') kind = 'turn.started';
      else if (subtype === 'task_complete' || subtype === 'task_completed') kind = 'turn.completed';
      else if (subtype === 'turn_aborted') kind = 'turn.interrupted';
      else if (subtype === 'token_count') {
        const info = object(p.info);
        kind = 'usage.snapshot';
        Object.assign(data, { cumulative: usage(info?.total_token_usage), last_usage: usage(info?.last_token_usage), rate_limit_only: p.info === null && !!object(p.rate_limits) && Object.keys(object(p.rate_limits)!).length > 0 });
      } else if (subtype === 'user_message') {
        kind = 'message.user'; data.title = title(p.message); body = { text: text(p.message) };
      } else if (subtype === 'agent_message') { kind = 'message.assistant'; body = { text: text(p.message) }; }
      else if (subtype === 'agent_reasoning') { kind = 'reasoning.summary'; data.available = !!text(p.text); body = { text: text(p.text) }; }
    } else if (row.type === 'response_item') {
      if (subtype === 'message') {
        if (p.role === 'user') { kind = 'message.user'; data.title = title(text(p.content)); }
        else if (p.role === 'assistant') kind = 'message.assistant';
        body = { text: text(p.content) };
      } else if (subtype === 'agent_message') {
        const content = text(p.content);
        if (content.startsWith('Message Type: NEW_TASK\n') && content.includes('\nPayload:\n')) {
          kind = 'message.user'; data.title = title(content.split('\nPayload:\n').slice(1).join('\nPayload:\n'));
        } else kind = 'message.assistant';
        body = { text: content };
      } else if (subtype === 'reasoning') {
        const summary = text(p.summary); kind = 'reasoning.summary'; data.available = !!summary.trim(); body = summary ? { text: summary } : null;
      } else if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(subtype)) {
        const args = p.arguments ?? p.input ?? p.action;
        kind = 'tool.called';
        Object.assign(data, { call_id: typeof p.call_id === 'string' ? p.call_id : null, name: typeof p.name === 'string' ? p.name : 'exec', input_bytes: bytes(args) });
        body = { arguments: args ?? null };
      } else if (['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(subtype)) {
        kind = 'tool.returned';
        Object.assign(data, { call_id: typeof p.call_id === 'string' ? p.call_id : null, output_bytes: bytes(p.output), status: 'result_observed' });
        body = { output: p.output ?? null };
      }
    } else if (row.type === 'compacted') { kind = 'context.compacted'; body = { text: text(p.message ?? p.summary) }; }
    return {
      schema_version: 1,
      event_id: hash(JSON.stringify(['codex', instance, sessionId, ...(series ? [series] : []), line])),
      archive_seq: 0,
      runtime: 'codex', instance_id: instance, session_id: sessionId, session_key: sessionKey, project_id: project,
      kind, occurred_at: timestamp(row.timestamp), observed_at: observedAt,
      native_type: row.type + (subtype ? '.' + subtype : ''),
      source: { path: sourcePath, line, record_hash, ...(series ? { series } : {}) }, data,
      body: mode === 'content' ? body : null, raw: mode === 'content' ? row : null,
    };
  });
}
