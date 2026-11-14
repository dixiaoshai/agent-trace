import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ApiError,
  MAX_PAGE_BYTES,
  authorizeRequest,
  authorizeView,
  buildApiStatus,
  errorResponse,
  parseEventsQuery,
  parseStatusQuery,
} from './api.ts';
import type { ApiConfig } from './config.ts';
import type { Archive } from './store.ts';
import type { CollectionStatus } from './api.ts';

export interface LocalApiServerOptions {
  archive: Archive;
  api: ApiConfig;
  collectionStatus: () => CollectionStatus;
  /** Test/embedding override; the public service always uses the fixed contract value. */
  maxPageBytes?: number;
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/**
 * Read-only local HTTP surface. Routing is intentionally tiny: the batch is
 * always produced by Archive.exportBatch and every request goes through the
 * P0 authorization/query/error helpers. No request body is read or logged.
 */
export class LocalApiServer {
  private readonly server: Server;
  private readonly options: LocalApiServerOptions;
  private readonly maxPageBytes: number;
  private started = false;

  constructor(options: LocalApiServerOptions) {
    this.options = options;
    this.maxPageBytes = options.maxPageBytes ?? MAX_PAGE_BYTES;
    this.server = createServer((request, response) => this.handle(request, response));
  }

  async start(): Promise<void> {
    if (this.started) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen({ host: this.options.api.host, port: this.options.api.port });
    });
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => error ? reject(error) : resolve());
      this.server.closeIdleConnections?.();
    });
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    try {
      const rawUrl = request.url ?? '/';
      // Parse with a fixed base: a hostile Host header must not affect routing.
      const url = new URL(rawUrl, 'http://127.0.0.1');
      if (url.pathname !== '/v1/events' && url.pathname !== '/v1/status') {
        throw new ApiError(404, 'NOT_FOUND', 'Unknown path');
      }
      if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Only GET is supported');
      const client = authorizeRequest({
        host: request.headers.host,
        origin: request.headers.origin,
        authorization: request.headers.authorization,
      }, this.options.api);

      if (url.pathname === '/v1/events') {
        const query = parseEventsQuery(url.search.slice(1));
        authorizeView(client, query.view);
        const batch = this.options.archive.exportBatch(query.after, query.limit, query.view);
        const body = serialize(batch);
        if (Buffer.byteLength(body) > this.maxPageBytes) {
          throw new ApiError(413, 'PAGE_TOO_LARGE', `Serialized page exceeds ${this.maxPageBytes} bytes; retry with a smaller limit`);
        }
        send(response, 200, body);
        return;
      }

      parseStatusQuery(url.search.slice(1));
      const archive = this.options.archive.status();
      const body = serialize(buildApiStatus(
        { archive_id: archive.archive_id, capture_mode: archive.capture_mode, high_watermark: archive.high_watermark },
        this.options.collectionStatus(),
      ));
      send(response, 200, body);
    } catch (error) {
      const mapped = errorResponse(error);
      send(response, mapped.status, serialize(mapped.body));
    }
  }
}
