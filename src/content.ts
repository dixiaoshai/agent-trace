import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArchiveError, object, type Event, type JsonObject } from './types.ts';

/**
 * Content capture protection.
 *
 * Content mode stores prompts, visible reasoning, tool arguments and tool
 * results. Before an event is handed to the archive transaction it is passed
 * through this module:
 *
 * 1. Every string in `data.title`, `body` and `raw` is scanned for well-known
 *    credential shapes and secret-looking key/value pairs. Matches become
 *    explicit `[REDACTED:<kind>]` markers, never silent deletions.
 * 2. A string longer than the configured inline limit is written to a
 *    content-addressed blob file and replaced by a `content_ref` object with
 *    the absolute path, byte length and SHA-256. Nothing is truncated; readers
 *    can verify the reference before using it.
 *
 * Redaction is deliberately heuristic. It lowers accidental leakage of common
 * credentials but does not prove that free prose, source code or novel token
 * formats are secret-free. Select sources accordingly and keep the resulting
 * database and blob directory private.
 */

export const DEFAULT_MAX_INLINE_BYTES = 64 * 1024;
export const MIN_MAX_INLINE_BYTES = 1;
export const MAX_MAX_INLINE_BYTES = 8 * 1024 * 1024;
export const CONTENT_REF_KEY = 'content_ref';
const MAX_DEPTH = 64;
const DEPTH_MARKER = '[REDACTED:depth_limit]';

export interface ContentOptions {
  max_inline_bytes?: number;
  blob_directory?: string;
}

export interface ContentPolicy {
  max_inline_bytes: number;
  /** Absolute directory holding externalized (redacted) content. */
  blob_directory: string;
}

export interface ContentRef {
  path: string;
  bytes: number;
  sha256: string;
  media_type: 'text/plain';
}

/**
 * Field names whose *value* is treated as a credential. This is an explicit
 * list on purpose: a generic `*token` suffix would rewrite package names such
 * as `js-tokens` and prose such as "fewer tokens:".
 */
const SECRET_KEY =
  String.raw`api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|` +
  String.raw`password|passwd|pwd|token|access[_-]?token|auth[_-]?token|refresh[_-]?token|` +
  String.raw`id[_-]?token|authorization|credential|secret`;
const KEY = String.raw`(\b(?:${SECRET_KEY})\b["']?\s*[:=]\s*)`;

/** Quoted values are redacted unless they only reference a secret or a placeholder. */
const QUOTED = String.raw`(?!\[REDACTED:)"(?!\$|<|\{|\^|~)[^"\n]{1,4096}"`;
/** Plain values must not look like a reference/placeholder and are bounded. */
const PLAIN = String.raw`(?!\[REDACTED:)(?!["'$<{])([^\s,;&}\]\n]{4,4096})`;

/**
 * Credential shapes that are safe to recognize without unbounded backtracking.
 * The replacement text names the class of secret so reviewers can tell a real
 * redaction from missing content.
 */
type Replacement = string | ((match: string, ...groups: string[]) => string);
const RULES: ReadonlyArray<readonly [RegExp, Replacement]> = [
  [/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]{0,65536}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g, '[REDACTED:private_key]'],
  [/(\b(?:proxy-)?authorization\s*:\s*)(?:bearer|basic|digest|token)\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi, '$1[REDACTED:credential]'],
  // A bare scheme word ("Basic", "Digest", "Token") also starts ordinary prose
  // such as "basic instructions", so the value itself must look credential-ish.
  [/\b(?:Bearer|Basic|Digest|Token)\s+([A-Za-z0-9._~+/-]{8,}={0,2})/gi,
    (match, value) => (looksLikeCredential(value ?? '') ? '[REDACTED:credential]' : match)],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, '[REDACTED:api_key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED:github_token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED:github_token]'],
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g, '[REDACTED:aws_key]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack_token]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED:jwt]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED:google_key]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[REDACTED:gitlab_token]'],
  [/\bnpm_[A-Za-z0-9]{30,}/g, '[REDACTED:npm_token]'],
  [/\b([a-z][a-z0-9+.-]{0,32}:\/\/)[^\s/@:]{1,128}:[^\s/@]{1,128}@/gi, '$1[REDACTED:userinfo]@'],
  [new RegExp(`${KEY}${QUOTED}`, 'gi'), '$1"[REDACTED:secret]"'],
  [new RegExp(`${KEY}(?!\\[REDACTED:)'[^'\\n]{1,4096}'`, 'gi'), "$1'[REDACTED:secret]'"],
  [new RegExp(`${KEY}${PLAIN}`, 'gi'), '$1[REDACTED:secret]'],
];

/**
 * Does a scheme value look like a token rather than an English word? Real
 * tokens carry digits, separators or mixed case; "instructions", "authentication"
 * and "algorithm" do not.
 */
function looksLikeCredential(value: string): boolean {
  const core = value.replace(/[.,;:!?)\]'"]+$/, '').replace(/=+$/, '');
  if (/\d/.test(core)) return true;
  // Base64-ish tokens mix case repeatedly; a capitalised English word does not.
  const upper = (core.match(/[A-Z]/g) ?? []).length;
  const lower = (core.match(/[a-z]/g) ?? []).length;
  if (core.length >= 12 && upper >= 2 && lower >= 2) return true;
  // Long separator-bearing opaque strings (e.g. bearer tokens built from words)
  // stay redacted; short CLI flags and dotted prose names do not.
  return /[._~+/-]/.test(core) && core.length >= 24;
}

/** Replace recognized credential shapes. Pure and idempotent for markers. */
export function redactText(value: string): string {
  if (!value) return value;
  let out = value;
  for (const [pattern, replacement] of RULES) {
    try {
      out = typeof replacement === 'string'
        ? out.replace(pattern, replacement)
        : out.replace(pattern, replacement as (match: string, ...groups: string[]) => string);
    } catch { /* never let one rule abort capture */ }
  }
  return out;
}

const SENSITIVE_KEY = /(?:^|[_-])(?:api_?key|access_?key|secret_?key|private_?key|token|secret|password|passwd|credential)$/i;
const SENSITIVE_EXACT = /^(?:apikey|authorization|proxy-authorization)$/i;

/** Structured tool arguments carry secrets under names, not just in prose. */
function sensitiveKey(key: string): boolean {
  return SENSITIVE_EXACT.test(key) || SENSITIVE_KEY.test(key);
}

/**
 * Redact every string inside a JSON-like value, keeping its shape. A value
 * stored under an obviously secret field name is replaced as a whole, because
 * a short password or opaque token would not match any textual rule.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (depth >= MAX_DEPTH) return DEPTH_MARKER;
  if (Array.isArray(value)) return value.map(entry => redactValue(entry, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sensitiveKey(key) ? '[REDACTED:secret]' : redactValue(entry, depth + 1);
    }
    return out;
  }
  return value;
}

function positiveInteger(value: unknown, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < MIN_MAX_INLINE_BYTES || Number(value) > max) {
    throw new ArchiveError('INVALID_INPUT', `${label} must be an integer between ${MIN_MAX_INLINE_BYTES} and ${max}`);
  }
  return Number(value);
}

/** Default blob directory sits beside the archive database, not in the source tree. */
export function defaultBlobDirectory(database: string): string {
  const resolved = database === ':memory:' ? path.join(os.tmpdir(), 'agent-trace-blobs') : path.resolve(database);
  return path.join(path.dirname(resolved), 'content-blobs');
}

export function contentPolicy(database: string, options: ContentOptions = {}): ContentPolicy {
  const maxInline = options.max_inline_bytes === undefined
    ? DEFAULT_MAX_INLINE_BYTES
    : positiveInteger(options.max_inline_bytes, 'max_inline_bytes', MAX_MAX_INLINE_BYTES);
  const directory = options.blob_directory ?? defaultBlobDirectory(database);
  if (!directory || !path.isAbsolute(directory) || directory.length > 4096 || /[\x00-\x1f]/.test(directory)) {
    throw new ArchiveError('INVALID_INPUT', 'blob_directory must be an absolute bounded path');
  }
  return { max_inline_bytes: maxInline, blob_directory: path.normalize(directory) };
}

/** Same single-line, ≤80-character rule the adapters use for metadata titles. */
export function boundedTitle(value: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  const chars = Array.from(cleaned);
  return chars.length > 80 ? chars.slice(0, 79).join('') + '…' : cleaned;
}

function blobPath(eventId: string, digest: string, directory: string): string {
  // One event may externalize several strings; the digest keeps them distinct.
  // Including the event ID prevents two sessions from sharing a file, so
  // deleting one session cannot break another session's reference.
  return path.join(directory, `${eventId}-${digest}.txt`);
}

function writeBlob(eventId: string, value: string, policy: ContentPolicy): ContentRef {
  const buffer = Buffer.from(value, 'utf8');
  const digest = createHash('sha256').update(buffer).digest('hex');
  const target = blobPath(eventId, digest, policy.blob_directory);
  try {
    mkdirSync(policy.blob_directory, { recursive: true, mode: 0o700 });
    chmodSync(policy.blob_directory, 0o700);
    let present = false;
    try { present = lstatSync(target).isFile(); } catch { present = false; }
    if (!present) {
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        writeFileSync(temporary, buffer, { mode: 0o600, flag: 'wx' });
        renameSync(temporary, target);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
      chmodSync(target, 0o600);
    }
  } catch (error) {
    throw new ArchiveError('CONTENT_STORAGE', `Cannot store externalized content in ${policy.blob_directory}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { path: target, bytes: buffer.length, sha256: digest, media_type: 'text/plain' };
}

export function isContentRef(value: unknown): value is JsonObject & { [CONTENT_REF_KEY]: ContentRef } {
  const wrapper = object(value);
  if (!wrapper || Object.keys(wrapper).length !== 1) return false;
  const ref = object(wrapper[CONTENT_REF_KEY]);
  return !!ref
    && typeof ref.path === 'string' && ref.path.length > 0 && ref.path.length <= 4096
    && Number.isSafeInteger(ref.bytes) && Number(ref.bytes) >= 0
    && typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256)
    && ref.media_type === 'text/plain';
}

/** Replace oversized strings with explicit references; never truncate silently. */
function externalize(value: unknown, eventId: string, policy: ContentPolicy, depth = 0): unknown {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) <= policy.max_inline_bytes) return value;
    return { [CONTENT_REF_KEY]: writeBlob(eventId, value, policy) };
  }
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map(entry => externalize(entry, eventId, policy, depth + 1));
  if (value !== null && typeof value === 'object') {
    if (isContentRef(value)) return value;
    const out: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) out[key] = externalize(entry, eventId, policy, depth + 1);
    return out;
  }
  return value;
}

/**
 * Prepare one content-mode event for storage. Pure apart from blob writes;
 * called before the archive transaction so a storage failure cannot commit a
 * half-captured event. Identity, timestamps and `source.record_hash` are left
 * unchanged: the hash still asserts the original source line.
 */
export function protectEvent(event: Event, policy: ContentPolicy): Event {
  const data: JsonObject = { ...event.data };
  if (typeof data.title === 'string') data.title = boundedTitle(redactText(data.title));
  return {
    ...event,
    data,
    body: event.body === null ? null : externalize(redactValue(event.body), event.event_id, policy) as JsonObject,
    raw: event.raw === null ? null : externalize(redactValue(event.raw), event.event_id, policy) as JsonObject,
  };
}

/** Every externalized path referenced by a stored event payload. */
export function referencedBlobs(payload: string): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth >= MAX_DEPTH) return;
    if (Array.isArray(value)) { for (const entry of value) visit(entry, depth + 1); return; }
    if (value === null || typeof value !== 'object') return;
    if (isContentRef(value)) { found.add(value[CONTENT_REF_KEY].path); return; }
    for (const entry of Object.values(value)) visit(entry, depth + 1);
  };
  try { visit(JSON.parse(payload), 0); } catch { /* an unreadable payload owns no known blobs */ }
  return [...found];
}

/**
 * Remove blobs owned by events that the archive just deleted or replaced.
 * Only files directly inside the configured directory are unlinked, so a
 * corrupted payload can never turn this into an arbitrary-file delete.
 */
export function removeBlobs(paths: Iterable<string>, policy: ContentPolicy): number {
  const root = path.resolve(policy.blob_directory);
  let removed = 0;
  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    if (path.dirname(resolved) !== root) continue;
    try { rmSync(resolved); removed++; } catch { /* already gone or not removable */ }
  }
  return removed;
}

/** Redact strings in runtime log/status objects; bodies are never logged. */
export function redactLog<T>(value: T): T {
  return redactValue(value) as T;
}
