import { createHash, timingSafeEqual } from 'node:crypto';
import type { ApiClientConfig, LoopbackHost } from './config.ts';
import { ArchiveError, type Batch, type View } from './types.ts';

/**
 * Fixed local HTTP contract for the read-only event feed. The server is
 * implemented in the next stage; request parsing, authorization, error mapping
 * and the status envelope are defined here so consumers and the server share
 * one versioned contract.
 */
export const API_SCHEMA_VERSION = 1;
export const API_PREFIX = '/v1';
export const DEFAULT_PAGE_EVENTS = 500;
export const MAX_PAGE_EVENTS = 1000;
export const MAX_PAGE_BYTES = 32 * 1024 * 1024;
export const MAX_QUERY_CHARS = 4096;
export const MAX_TOKEN_CHARS = 1024;
export const VIEWS: readonly View[] = ['metadata', 'content'];

export type CollectionState = 'disabled' | 'starting' | 'idle' | 'scanning' | 'degraded' | 'stopped';

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export interface CollectionSourceStatus {
  instance_id: string;
  root: string;
  project_ids: string[];
  last_scan_at: string | null;
  last_error: { code: string; message: string; at: string } | null;
}

export interface CollectionScanSummary {
  files: number;
  imported: number;
  skipped: number;
  pending: number;
  unmatched_projects: number;
  errors: number;
}

export interface CollectionStatus {
  enabled: boolean;
  state: CollectionState;
  started_at: string | null;
  heartbeat_at: string | null;
  scan_interval_seconds: number | null;
  last_scan_started_at: string | null;
  last_scan_finished_at: string | null;
  last_scan: CollectionScanSummary | null;
  last_error: { code: string; message: string; at: string } | null;
  sources: CollectionSourceStatus[];
}

export interface ApiStatus {
  schema_version: 1;
  protocol: {
    schema_version: 1;
    default_page_events: number;
    max_page_events: number;
    max_page_bytes: number;
    views: View[];
  };
  archive: { archive_id: string; capture_mode: View; high_watermark: number };
  collection: CollectionStatus;
}

export interface EventsQuery {
  after: number;
  limit: number;
  view: View;
}

export interface RequestHeaders {
  host?: string | string[] | undefined;
  origin?: string | string[] | undefined;
  authorization?: string | string[] | undefined;
}

export interface ApiAuthConfig {
  host: LoopbackHost;
  port: number;
  clients: ApiClientConfig[];
}

/** HTTP-facing error. The message is safe to return to a local client. */
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'ApiError';
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function single(value: string | string[] | undefined, at: string): string | undefined {
  if (Array.isArray(value)) throw new ApiError(400, 'INVALID_HEADER', `${at} must not be repeated`);
  return value;
}

function loopbackHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

function assertHost(value: string | undefined, port: number): void {
  if (value === undefined || !loopbackHosts(port).has(value.toLowerCase())) {
    throw new ApiError(403, 'INVALID_HOST', `Host must be a loopback host with port ${port}`);
  }
}

function assertOrigin(value: string | undefined, port: number): void {
  if (value === undefined) return;
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
  if (!allowed.has(value.toLowerCase())) throw new ApiError(403, 'INVALID_ORIGIN', `Origin must be absent or a loopback origin with port ${port}`);
}

/**
 * Validate Host/Origin and resolve a bearer token to its configured client.
 * Every request is authenticated; binding to loopback is not treated as
 * authorization. The plaintext token is never logged or stored by Trace.
 */
export function authorizeRequest(headers: RequestHeaders, config: ApiAuthConfig): ApiClientConfig {
  assertHost(single(headers.host, 'Host'), config.port);
  assertOrigin(single(headers.origin, 'Origin'), config.port);
  const authorization = single(headers.authorization, 'Authorization');
  if (authorization === undefined) throw new ApiError(401, 'UNAUTHORIZED', 'A bearer token is required');
  if (authorization.length > MAX_TOKEN_CHARS + 7 || !authorization.startsWith('Bearer ')) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Authorization must use the Bearer scheme');
  }
  const token = authorization.slice('Bearer '.length);
  if (!token || token.length > MAX_TOKEN_CHARS || /\s/.test(token)) throw new ApiError(401, 'UNAUTHORIZED', 'Bearer token is malformed');
  const digest = Buffer.from(hashToken(token), 'hex');
  const matches = config.clients.filter(client => timingSafeEqual(digest, Buffer.from(client.token_sha256, 'hex')));
  if (matches.length !== 1) throw new ApiError(401, 'UNAUTHORIZED', 'Unknown bearer token');
  return matches[0]!;
}

export function authorizeView(client: ApiClientConfig, view: View): void {
  if (!client.views.includes(view)) throw new ApiError(403, 'FORBIDDEN_VIEW', `Client "${client.id}" is not authorized for the ${view} view`);
}

/**
 * Parse `GET /v1/events` query parameters. Parameters are optional and
 * canonical: `after` defaults to 0, `limit` to 500, `view` to metadata.
 * Unknown, empty, repeated or out-of-range values are rejected rather than
 * silently narrowed.
 */
export function parseEventsQuery(rawQuery: string): EventsQuery {
  if (rawQuery.length > MAX_QUERY_CHARS) throw new ApiError(414, 'QUERY_TOO_LARGE', `Query exceeds ${MAX_QUERY_CHARS} characters`);
  const params = new URLSearchParams(rawQuery);
  const seen = new Set<string>();
  for (const [key, value] of params) {
    if (seen.has(key)) throw new ApiError(400, 'INVALID_INPUT', `Query parameter "${key}" must not be repeated`);
    seen.add(key);
    if (!['after', 'limit', 'view'].includes(key)) throw new ApiError(400, 'INVALID_INPUT', `Unsupported query parameter "${key}"`);
    if (!value) throw new ApiError(400, 'INVALID_INPUT', `Query parameter "${key}" must not be empty`);
  }
  const afterText = params.get('after') ?? '0';
  if (!/^(?:0|[1-9][0-9]*)$/.test(afterText)) throw new ApiError(400, 'INVALID_CURSOR', 'after must be a nonnegative integer');
  const after = Number(afterText);
  if (!Number.isSafeInteger(after)) throw new ApiError(400, 'INVALID_CURSOR', 'after must be a safe integer');
  const limitText = params.get('limit') ?? String(DEFAULT_PAGE_EVENTS);
  if (!/^(?:[1-9][0-9]*)$/.test(limitText)) throw new ApiError(400, 'INVALID_INPUT', 'limit must be a positive integer');
  const limit = Number(limitText);
  if (!Number.isSafeInteger(limit) || limit > MAX_PAGE_EVENTS) throw new ApiError(400, 'INVALID_INPUT', `limit must be 1..${MAX_PAGE_EVENTS}`);
  const view = params.get('view') ?? 'metadata';
  if (view !== 'metadata' && view !== 'content') throw new ApiError(400, 'INVALID_INPUT', 'view must be metadata or content');
  return { after, limit, view };
}

/** `/v1/status` takes no query parameters; reject filters instead of implying scoped status. */
export function parseStatusQuery(rawQuery: string): void {
  if (rawQuery.length > MAX_QUERY_CHARS) throw new ApiError(414, 'QUERY_TOO_LARGE', `Query exceeds ${MAX_QUERY_CHARS} characters`);
  if (new URLSearchParams(rawQuery).size > 0) throw new ApiError(400, 'INVALID_INPUT', 'status does not accept query parameters');
}

export function apiErrorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export function httpStatusFor(code: string): number {
  switch (code) {
    case 'INVALID_INPUT':
    case 'INVALID_CURSOR':
    case 'INVALID_HEADER':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'INVALID_HOST':
    case 'INVALID_ORIGIN':
    case 'FORBIDDEN_VIEW':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'METHOD_NOT_ALLOWED':
      return 405;
    case 'PAGE_TOO_LARGE':
      return 413;
    case 'QUERY_TOO_LARGE':
      return 414;
    default:
      return 500;
  }
}

/** Convert an ApiError or archive error into a client-safe HTTP status and envelope. */
export function errorResponse(error: unknown): { status: number; body: ApiErrorBody } {
  if (error instanceof ApiError) return { status: error.status, body: apiErrorBody(error.code, error.message) };
  if (error instanceof ArchiveError) {
    // Known archive request errors keep their code; anything else is an internal error.
    const status = error.code === 'INVALID_INPUT' || error.code === 'INVALID_CURSOR' ? 400 : 500;
    return { status, body: apiErrorBody(status === 500 ? 'INTERNAL' : error.code, status === 500 ? 'Archive request failed' : error.message) };
  }
  return { status: 500, body: apiErrorBody('INTERNAL', 'Internal server error') };
}

/**
 * Build the stable `/v1/status` body. `high_watermark` is the highest committed
 * archive sequence; it is NOT a count of unread events because deletion leaves
 * sequence gaps and consumers keep independent cursors.
 */
export function buildApiStatus(
  archive: { archive_id: string; capture_mode: View; high_watermark: number },
  collection: CollectionStatus,
): ApiStatus {
  return {
    schema_version: API_SCHEMA_VERSION,
    protocol: {
      schema_version: API_SCHEMA_VERSION,
      default_page_events: DEFAULT_PAGE_EVENTS,
      max_page_events: MAX_PAGE_EVENTS,
      max_page_bytes: MAX_PAGE_BYTES,
      views: [...VIEWS],
    },
    archive: {
      archive_id: archive.archive_id,
      capture_mode: archive.capture_mode,
      high_watermark: archive.high_watermark,
    },
    collection,
  };
}

export type EventsResponse = Batch;
