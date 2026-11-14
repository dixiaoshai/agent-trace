import type { JsonObject } from './types.ts';
import { ArchiveError } from './types.ts';
import { Archive } from './store.ts';
import { redactLog } from './content.ts';
import { Collector } from './collector.ts';
import { LocalApiServer } from './server.ts';
import type { CollectionStatus } from './api.ts';
import type { ServiceConfig } from './config.ts';

export interface ServiceEvent extends JsonObject {
  type: string;
  at: string;
}

export interface TraceServiceOptions {
  onEvent?: (event: ServiceEvent) => void;
  /** Test/embedding hooks; normal serve uses the documented defaults. */
  leaseTtlMs?: number;
  maxPageBytes?: number;
  scheduleScans?: boolean;
  now?: () => number;
}

/**
 * Foreground service: the collection scheduler, the read-only local API and the
 * one archive database share a single process and stop together. It never
 * contacts the two consumers and stores no delivery state for them.
 */
export class TraceService {
  readonly config: ServiceConfig;
  readonly archive: Archive;
  readonly collector: Collector;
  private readonly options: TraceServiceOptions;
  private server: LocalApiServer | null;
  private started = false;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;

  constructor(config: ServiceConfig, options: TraceServiceOptions = {}) {
    this.config = config;
    this.options = options;
    this.archive = new Archive(config.database, config.capture_mode, config.content);
    this.collector = new Collector(config, this.archive, {
      leaseTtlMs: options.leaseTtlMs,
      now: options.now,
      scheduleScans: options.scheduleScans,
      onFatal: error => this.emit({
        type: 'collection.error',
        at: new Date().toISOString(),
        code: error.code,
        message: error.message,
      }),
      onScan: (summary, state) => this.emit({
        type: 'collection.scan',
        at: new Date(this.options.now?.() ?? Date.now()).toISOString(),
        state,
        ...summary,
      }),
    });
    this.server = config.api.enabled ? new LocalApiServer({
      archive: this.archive,
      api: config.api,
      collectionStatus: () => this.collector.status(),
      maxPageBytes: options.maxPageBytes,
    }) : null;
  }

  private emit(event: ServiceEvent): void {
    // Runtime logs can quote source errors; redact strings defensively so a
    // credential in a path or message never reaches stdout.
    this.options.onEvent?.(redactLog(event));
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.stopped) throw new ArchiveError('SERVICE_STOPPED', 'Service has already stopped');
    if (!this.config.collection.enabled && !this.config.api.enabled) {
      this.archive.close();
      throw new ArchiveError('INVALID_CONFIG', 'serve requires collection.enabled or api.enabled');
    }
    try {
      this.collector.start();
      if (this.server) await this.server.start();
    } catch (error) {
      await this.stop('startup-error');
      throw error;
    }
    this.started = true;
    this.emit({
      type: 'serve.started',
      at: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      database: this.config.database,
      archive_id: this.archive.archiveId,
      capture_mode: this.archive.captureMode,
      collection: {
        enabled: this.config.collection.enabled,
        scan_interval_seconds: this.config.collection.enabled ? this.config.collection.scan_interval_seconds : null,
        backfill: this.config.collection.backfill,
      },
      api: {
        enabled: this.config.api.enabled,
        host: this.config.api.host,
        port: this.config.api.port,
      },
    });
  }

  stop(reason = 'signal'): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop(reason);
    return this.stopPromise;
  }

  private async performStop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try { await this.collector.stop(); } catch { /* best-effort cleanup */ }
    if (this.server) {
      try { await this.server.stop(); } catch { /* best-effort cleanup */ }
    }
    try { this.archive.close(); } catch { /* already closed after a startup failure */ }
    this.emit({
      type: 'serve.stopped',
      at: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      reason,
      archive_id: this.archive.archiveId,
      collection_state: this.collector.status().state,
    });
  }

  status(): CollectionStatus {
    return this.collector.status();
  }

  scanOnce(): ReturnType<Collector['scanOnce']> {
    return this.collector.scanOnce();
  }
}
