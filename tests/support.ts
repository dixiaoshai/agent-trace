import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadServiceConfig, type ServiceConfig } from '../src/config.ts';

export const STATS_TOKEN = 'synthetic-metadata-token-value';
export const KNOWLEDGE_TOKEN = 'synthetic-content-token-value!!';
export const STATS_TOKEN_HASH = createHash('sha256').update(STATS_TOKEN).digest('hex');
export const KNOWLEDGE_TOKEN_HASH = createHash('sha256').update(KNOWLEDGE_TOKEN).digest('hex');
export const EXTRA_EVENT = `${JSON.stringify({
  timestamp: '2026-01-01T00:00:11Z',
  type: 'event_msg',
  payload: { type: 'user_message', turn_id: 'turn-2', message: 'synthetic appended event' },
})}\n`;

export function temporaryDirectory(t: { after: (fn: () => void | Promise<void>) => void }, prefix = 'agent-trace-p1-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

export function fixtureLog(cwd: string, sessionId = 'archive-demo-session'): string {
  const text = readFileSync(path.resolve('fixtures/codex/demo.jsonl'), 'utf8');
  const newline = text.indexOf('\n');
  const first = JSON.parse(text.slice(0, newline)) as { payload: { cwd: string; id: string } };
  first.payload.cwd = cwd;
  first.payload.id = sessionId;
  return `${JSON.stringify(first)}${text.slice(newline)}`;
}

export function appendExtraEvent(filename: string): void {
  appendFileSync(filename, EXTRA_EVENT);
}

export interface ServiceConfigOptions {
  database?: string;
  captureMode?: 'metadata' | 'content';
  collection?: Record<string, unknown>;
  api?: Record<string, unknown>;
}

export function writeServiceConfig(dir: string, options: ServiceConfigOptions = {}): string {
  const filename = path.join(dir, 'agent-trace.service.json');
  const value = {
    schema_version: 1,
    database: options.database ?? 'state/trace.sqlite',
    capture_mode: options.captureMode ?? 'content',
    collection: options.collection ?? { enabled: false, sources: [] },
    api: options.api ?? { enabled: false },
  };
  writeFileSync(filename, JSON.stringify(value, null, 2));
  return filename;
}

export function loadConfig(filename: string): ServiceConfig {
  return loadServiceConfig(filename);
}

export async function freeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export interface RequestOptions {
  method?: string;
  token?: string;
  host?: string;
  origin?: string;
  headers?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: any;
}

export function request(port: number, requestPath: string, options: RequestOptions = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: options.host ?? `127.0.0.1:${port}`,
      Connection: 'close',
      ...options.headers,
    };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.origin) headers.Origin = options.origin;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method: options.method ?? 'GET',
      headers,
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = body ? JSON.parse(body) : null; } catch { json = null; }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 8_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`waitFor timed out after ${timeoutMs}ms${suffix}`);
}
