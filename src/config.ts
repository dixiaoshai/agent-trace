import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_MAX_INLINE_BYTES, MAX_MAX_INLINE_BYTES, MIN_MAX_INLINE_BYTES, defaultBlobDirectory, type ContentPolicy } from './content.ts';
import { defaultDatabase } from './paths.ts';
import { ArchiveError, identifier, type JsonObject, type RuntimeHint, type View } from './types.ts';

/**
 * Service configuration is deliberately explicit and strict. Unknown keys are
 * rejected so a typo cannot silently widen collection or API access.
 * Relative paths are resolved against the configuration file's directory.
 */
export const SERVICE_CONFIG_VERSION = 1;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_PATH_CHARS = 4096;
const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;
const DEFAULT_SCAN_INTERVAL_SECONDS = 30;
const DEFAULT_API_HOST = '127.0.0.1';
const DEFAULT_API_PORT = 8766;

export type BackfillPolicy = 'none' | 'all';
export type LoopbackHost = (typeof LOOPBACK_HOSTS)[number];

export interface ProjectScope {
  project_id: string;
  /** Absolute, resolved directories. A session cwd must be equal to or below one of them. */
  cwd_allowlist: string[];
}

export interface SourceConfig {
  instance_id: string;
  /** Absolute, resolved file or directory selected for collection. */
  root: string;
  /** "auto" detects Codex rollouts and pi sessions from the first record. */
  runtime: RuntimeHint;
  projects: ProjectScope[];
}

export interface CollectionConfig {
  enabled: boolean;
  scan_interval_seconds: number;
  backfill: BackfillPolicy;
  sources: SourceConfig[];
}

export interface ApiClientConfig {
  id: string;
  views: View[];
  /** Lowercase SHA-256 hex of the bearer token; the plaintext token is never stored. */
  token_sha256: string;
}

export interface ApiConfig {
  enabled: boolean;
  host: LoopbackHost;
  port: number;
  clients: ApiClientConfig[];
}

export interface ServiceConfig {
  schema_version: 1;
  config_path: string;
  database: string;
  capture_mode: View;
  /** Content-mode protection; also exposed for metadata archives where it is unused. */
  content: ContentPolicy;
  collection: CollectionConfig;
  api: ApiConfig;
}

export interface LoadServiceConfigOptions {
  /** Like the existing --db flag: an explicit path wins over the configuration file. */
  database?: string;
}

export interface ProjectMatch {
  project_id: string;
}

export interface ProjectMismatch {
  error: 'PROJECT_UNMATCHED' | 'PROJECT_AMBIGUOUS';
  message: string;
}

function invalid(at: string, message: string): never {
  throw new ArchiveError('INVALID_CONFIG', `${at}: ${message}`);
}

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strictObject(value: unknown, at: string, keys: readonly string[], required: readonly string[]): JsonObject {
  if (!isPlainObject(value)) invalid(at, 'must be a JSON object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(at, `unknown key "${key}"`);
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(at, `missing required key "${key}"`);
  return value;
}

function boolean(value: unknown, at: string): boolean {
  if (typeof value !== 'boolean') invalid(at, 'must be a boolean');
  return value;
}

function integer(value: unknown, at: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid(at, `must be an integer between ${min} and ${max}`);
  return Number(value);
}

function text(value: unknown, at: string): string {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_CHARS || /[\x00-\x1f]/.test(value)) {
    invalid(at, 'must be a nonempty bounded string without control characters');
  }
  return value;
}

function resolvePath(value: unknown, at: string, directory: string): string {
  const raw = text(value, at);
  if (raw.startsWith('~')) invalid(at, 'home-relative paths are not expanded; use an absolute path or a path relative to the configuration file');
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return path.resolve(directory, raw);
}

function id(value: unknown, at: string): string {
  try { return identifier(value, at); } catch { invalid(at, 'must be a nonempty bounded identifier'); }
}

function view(value: unknown, at: string): View {
  if (value !== 'metadata' && value !== 'content') invalid(at, 'must be "metadata" or "content"');
  return value;
}

function tokenHash(value: unknown, at: string): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) invalid(at, 'must be a 64-character SHA-256 hex digest');
  return value.toLowerCase();
}

function array(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) invalid(at, 'must be an array');
  return value;
}

function parseClients(value: unknown, at: string): ApiClientConfig[] {
  const clients = array(value, at).map((entry, index): ApiClientConfig => {
    const here = `${at}[${index}]`;
    const client = strictObject(entry, here, ['id', 'views', 'token_sha256'], ['id', 'views', 'token_sha256']);
    const clientId = id(client.id, `${here}.id`);
    const views = array(client.views, `${here}.views`);
    if (!views.length) invalid(`${here}.views`, 'must contain at least one view');
    const parsedViews = views.map((entryView, viewIndex) => view(entryView, `${here}.views[${viewIndex}]`));
    if (new Set(parsedViews).size !== parsedViews.length) invalid(`${here}.views`, 'must not repeat a view');
    return { id: clientId, views: parsedViews, token_sha256: tokenHash(client.token_sha256, `${here}.token_sha256`) };
  });
  const ids = new Set<string>();
  const tokens = new Set<string>();
  for (const [index, client] of clients.entries()) {
    if (ids.has(client.id)) invalid(`${at}[${index}].id`, `duplicate client id "${client.id}"`);
    if (tokens.has(client.token_sha256)) invalid(`${at}[${index}].token_sha256`, 'duplicate client token hash');
    ids.add(client.id);
    tokens.add(client.token_sha256);
  }
  return clients;
}

function parseSources(value: unknown, at: string, directory: string): SourceConfig[] {
  const sources = array(value, at).map((entry, index): SourceConfig => {
    const here = `${at}[${index}]`;
    const source = strictObject(entry, here, ['instance_id', 'runtime', 'root', 'projects'], ['instance_id', 'root', 'projects']);
    const instanceId = id(source.instance_id, `${here}.instance_id`);
    const root = resolvePath(source.root, `${here}.root`, directory);
    const runtime = source.runtime === undefined ? 'auto' : source.runtime;
    if (runtime !== 'auto' && runtime !== 'codex' && runtime !== 'pi') {
      invalid(`${here}.runtime`, 'must be "auto", "codex" or "pi"');
    }
    const projects = array(source.projects, `${here}.projects`);
    if (!projects.length) invalid(`${here}.projects`, 'must contain at least one project scope');
    const scopes = projects.map((projectEntry, projectIndex): ProjectScope => {
      const projectAt = `${here}.projects[${projectIndex}]`;
      const project = strictObject(projectEntry, projectAt, ['project_id', 'cwd_allowlist'], ['project_id', 'cwd_allowlist']);
      const projectId = id(project.project_id, `${projectAt}.project_id`);
      const allowlist = array(project.cwd_allowlist, `${projectAt}.cwd_allowlist`);
      if (!allowlist.length) invalid(`${projectAt}.cwd_allowlist`, 'must contain at least one directory');
      return {
        project_id: projectId,
        cwd_allowlist: allowlist.map((entryPath, allowIndex) => resolvePath(entryPath, `${projectAt}.cwd_allowlist[${allowIndex}]`, directory)),
      };
    });
    const projectIds = new Set<string>();
    for (const [projectIndex, project] of scopes.entries()) {
      if (projectIds.has(project.project_id)) invalid(`${here}.projects[${projectIndex}].project_id`, `duplicate project id "${project.project_id}" in one source`);
      projectIds.add(project.project_id);
    }
    return { instance_id: instanceId, root, runtime: runtime as RuntimeHint, projects: scopes };
  });
  const roots = new Map<string, string>();
  for (const [index, source] of sources.entries()) {
    if (roots.has(source.root)) invalid(`${at}[${index}].root`, `duplicate source root "${source.root}" (also selected by ${roots.get(source.root)})`);
    roots.set(source.root, `${at}[${index}]`);
  }
  return sources;
}

function parseContent(value: unknown, at: string, database: string, directory: string): ContentPolicy {
  if (value === undefined) {
    return { max_inline_bytes: DEFAULT_MAX_INLINE_BYTES, blob_directory: defaultBlobDirectory(database) };
  }
  const content = strictObject(value, at, ['max_inline_bytes', 'blob_directory'], []);
  const maxInline = content.max_inline_bytes === undefined
    ? DEFAULT_MAX_INLINE_BYTES
    : integer(content.max_inline_bytes, `${at}.max_inline_bytes`, MIN_MAX_INLINE_BYTES, MAX_MAX_INLINE_BYTES);
  // Relative to the configuration file, like every other configured path.
  const blobDirectory = content.blob_directory === undefined
    ? defaultBlobDirectory(database)
    : resolvePath(content.blob_directory, `${at}.blob_directory`, directory);
  return { max_inline_bytes: maxInline, blob_directory: blobDirectory };
}

/** Load and strictly validate a service configuration file. Does not create or open the archive database. */
export function loadServiceConfig(filename: string, options: LoadServiceConfigOptions = {}): ServiceConfig {
  const configPath = path.resolve(filename);
  let stat;
  try { stat = statSync(configPath); } catch { invalid('config', `cannot read ${configPath}`); }
  if (!stat.isFile()) invalid('config', `${configPath} is not a regular file`);
  if (stat.size > MAX_CONFIG_BYTES) invalid('config', `file exceeds ${MAX_CONFIG_BYTES} bytes`);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(configPath, 'utf8')); } catch (error) {
    invalid('config', `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const top = strictObject(parsed, 'config', ['schema_version', 'database', 'capture_mode', 'content', 'collection', 'api'], ['schema_version', 'collection', 'api']);
  if (top.schema_version !== SERVICE_CONFIG_VERSION) invalid('config.schema_version', `must be ${SERVICE_CONFIG_VERSION}`);
  const directory = path.dirname(configPath);
  const database = options.database !== undefined
    ? resolvePath(options.database, '--db', process.cwd())
    : top.database === undefined ? defaultDatabase(directory) : resolvePath(top.database, 'config.database', directory);
  const captureMode = top.capture_mode === undefined ? 'metadata' : view(top.capture_mode, 'config.capture_mode');
  const content = parseContent(top.content, 'config.content', database, directory);

  const collection = strictObject(top.collection, 'config.collection', ['enabled', 'scan_interval_seconds', 'backfill', 'sources'], ['enabled', 'sources']);
  const collectionEnabled = boolean(collection.enabled, 'config.collection.enabled');
  const interval = collection.scan_interval_seconds === undefined
    ? DEFAULT_SCAN_INTERVAL_SECONDS
    : integer(collection.scan_interval_seconds, 'config.collection.scan_interval_seconds', 1, 3600);
  const backfillValue = collection.backfill === undefined ? 'none' : collection.backfill;
  if (backfillValue !== 'none' && backfillValue !== 'all') invalid('config.collection.backfill', 'must be "none" or "all"');
  const sources = parseSources(collection.sources, 'config.collection.sources', directory);
  if (collectionEnabled && !sources.length) invalid('config.collection.sources', 'must not be empty when collection is enabled');

  const api = strictObject(top.api, 'config.api', ['enabled', 'host', 'port', 'clients'], ['enabled']);
  const apiEnabled = boolean(api.enabled, 'config.api.enabled');
  const host = api.host === undefined ? DEFAULT_API_HOST : api.host;
  if (typeof host !== 'string' || !(LOOPBACK_HOSTS as readonly string[]).includes(host)) {
    invalid('config.api.host', `must be one of ${LOOPBACK_HOSTS.join(', ')}; the API never binds a non-loopback address`);
  }
  const port = api.port === undefined ? DEFAULT_API_PORT : integer(api.port, 'config.api.port', 1, 65535);
  const clients = api.clients === undefined ? [] : parseClients(api.clients, 'config.api.clients');
  if (apiEnabled && !clients.length) invalid('config.api.clients', 'must not be empty when the API is enabled; anonymous access is not supported');

  return {
    schema_version: SERVICE_CONFIG_VERSION,
    config_path: configPath,
    database,
    capture_mode: captureMode,
    content,
    collection: { enabled: collectionEnabled, scan_interval_seconds: interval, backfill: backfillValue, sources },
    api: { enabled: apiEnabled, host: host as LoopbackHost, port, clients },
  };
}

/**
 * Match a session's metadata.cwd against one source's project scopes.
 * The longest matching allowlisted directory wins; an equal-length tie between
 * different projects is ambiguous and is skipped until the configuration is fixed.
 * Paths are compared lexically; symlinks are not resolved, so configure the same
 * path form that Codex reports in session metadata.
 */
export function projectForCwd(source: SourceConfig, cwd: unknown): ProjectMatch | ProjectMismatch {
  if (typeof cwd !== 'string' || !cwd || cwd.trim() !== cwd || cwd.length > MAX_PATH_CHARS || !path.isAbsolute(cwd) || /[\x00-\x1f]/.test(cwd)) {
    return { error: 'PROJECT_UNMATCHED', message: 'Session cwd is missing, not absolute, or not a bounded path' };
  }
  const target = path.resolve(cwd);
  let bestLength = -1;
  let best: string[] = [];
  for (const project of source.projects) {
    for (const root of project.cwd_allowlist) {
      const resolved = path.resolve(root);
      const relative = path.relative(resolved, target);
      if (relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) continue;
      if (resolved.length > bestLength) { bestLength = resolved.length; best = [project.project_id]; }
      else if (resolved.length === bestLength && !best.includes(project.project_id)) best.push(project.project_id);
    }
  }
  if (!best.length) return { error: 'PROJECT_UNMATCHED', message: `Session cwd is outside the configured allowlists: ${target}` };
  if (best.length > 1) return { error: 'PROJECT_AMBIGUOUS', message: `Session cwd matches multiple projects at the same depth: ${best.join(', ')}` };
  return { project_id: best[0]! };
}

/** JSON-safe summary for config-check and logs; token hashes are deliberately omitted. */
export function describeServiceConfig(config: ServiceConfig): JsonObject {
  return {
    schema_version: config.schema_version,
    config_path: config.config_path,
    database: config.database,
    capture_mode: config.capture_mode,
    content: {
      max_inline_bytes: config.content.max_inline_bytes,
      blob_directory: config.content.blob_directory,
    },
    collection: {
      enabled: config.collection.enabled,
      scan_interval_seconds: config.collection.scan_interval_seconds,
      backfill: config.collection.backfill,
      sources: config.collection.sources.map(source => ({
        instance_id: source.instance_id,
        runtime: source.runtime,
        root: source.root,
        projects: source.projects.map(project => ({ project_id: project.project_id, cwd_allowlist: [...project.cwd_allowlist] })),
      })),
    },
    api: {
      enabled: config.api.enabled,
      host: config.api.host,
      port: config.api.port,
      clients: config.api.clients.map(client => ({ id: client.id, views: [...client.views] })),
    },
  };
}
