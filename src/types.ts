import { createHash } from 'node:crypto';

export type JsonObject = Record<string, unknown>;
export type View = 'metadata' | 'content';
export interface Event {
  schema_version: 1;
  event_id: string;
  archive_seq: number;
  runtime: string;
  instance_id: string;
  session_id: string;
  session_key: string;
  project_id: string;
  kind: string;
  occurred_at: string | null;
  observed_at: string;
  native_type: string;
  source: { path: string; line: number; record_hash: string } | null;
  data: JsonObject;
  body: JsonObject | null;
  raw: JsonObject | null;
}
export interface Batch {
  schema_version: 1;
  archive_id: string;
  view: View;
  after_cursor: number;
  next_cursor: number;
  has_more: boolean;
  events: Event[];
}
export class ArchiveError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'ArchiveError'; }
}
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}
export function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > 500 || /[\x00-\x1f]/.test(value)) {
    throw new ArchiveError('INVALID_INPUT', `${label} must be a nonempty bounded identifier`);
  }
  return value;
}
export function viewOf(value: unknown): View {
  if (value !== 'metadata' && value !== 'content') throw new ArchiveError('INVALID_INPUT', 'view must be metadata or content');
  return value;
}
export function cursorOf(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ArchiveError('INVALID_CURSOR', 'cursor must be a nonnegative safe integer');
  return value as number;
}
export function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
