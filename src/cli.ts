#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { writeFileSync } from 'node:fs';
import { Archive, sourceFiles } from './store.ts';
import { describeServiceConfig, loadServiceConfig } from './config.ts';
import { TraceService, type ServiceEvent } from './service.ts';
import { ArchiveError, cursorOf, identifier, runtimeHint as parseRuntimeHint, viewOf } from './types.ts';
import { defaultDatabase } from './paths.ts';

const help = `Agent Trace — local shared execution evidence
Usage: agent-trace <command> [options]
Node.js >=24.15.0; no runtime dependencies; no automatic history import.

Commands (all accept --db PATH, default .agent-trace/trace.sqlite):
  ingest --source PATH [--source PATH ...] --instance ID --project ID [--runtime auto|codex|pi|dsh] [--capture metadata|content]
  export [--after CURSOR] [--limit 1..10000] [--view metadata|content] [--output FILE]
  read --event ID [--view metadata|content]
  delete-session --runtime codex --instance ID --session ID
  status
  gc --config PATH [--db PATH] [--dry-run]
  config-check --config PATH [--db PATH]
  serve --config PATH [--db PATH]
  help

gc removes blob files in the configured content archive that no committed event
cites (for example files left by an interrupted import); --dry-run only reports.
Content capture saves selected original prompts, tools and visible reasoning.
Capture mode is fixed per database; metadata is the default. Export files may
contain private information and are independent copies with their own lifecycle.
An existing .agent-archive/archive.sqlite remains the fallback when the new
default database does not exist. An explicit --db always takes precedence.
config-check validates a service configuration without creating a database,
starting collection or opening a listener. serve runs collection and/or the
read-only loopback API in the foreground until SIGINT/SIGTERM; startup,
scan and stop events are emitted as NDJSON. See docs/service-config.md and
docs/local-api.md.
`;
const commandOptions: Record<string, ParseArgsConfig['options']> = {
  ingest: { source: { type: 'string', multiple: true }, instance: { type: 'string' }, project: { type: 'string' }, runtime: { type: 'string' }, capture: { type: 'string' } },
  export: { after: { type: 'string' }, limit: { type: 'string' }, view: { type: 'string' }, output: { type: 'string' } },
  read: { event: { type: 'string' }, view: { type: 'string' } },
  'delete-session': { runtime: { type: 'string' }, instance: { type: 'string' }, session: { type: 'string' } },
  status: {}, gc: { config: { type: 'string' }, 'dry-run': { type: 'boolean' } },
  'config-check': { config: { type: 'string' } }, serve: { config: { type: 'string' } }, help: {},
};
async function main(): Promise<void> {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h') { process.stdout.write(help); return; }
  if (!Object.hasOwn(commandOptions, command)) throw new ArchiveError('INVALID_INPUT', `Unknown command: ${command}`);
  const parsed = parseArgs({ args, options: { ...commandOptions[command], db: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false });
  const v: Record<string, string | string[] | boolean | undefined> = parsed.values;
  if (command === 'help' || v.help) { process.stdout.write(help); return; }
  const sources = command === 'ingest' ? v.source as string[] | undefined : undefined;
  const instance = command === 'ingest' || command === 'delete-session' ? identifier(v.instance, '--instance') : '';
  const project = command === 'ingest' ? identifier(v.project, '--project') : '';
  const session = command === 'delete-session' ? identifier(v.session, '--session') : '';
  const runtime = command === 'delete-session' ? identifier(v.runtime, '--runtime') : '';
  const runtimeHint = command === 'ingest'
    ? (v.runtime === undefined ? 'auto' : parseRuntimeHint(identifier(v.runtime, '--runtime')))
    : 'auto';
  if (runtimeHint === null) {
    throw new ArchiveError('INVALID_INPUT', '--runtime must be auto, codex, pi or dsh (alias deepseek-harness)');
  }
  if (command === 'ingest' && !sources?.length) throw new ArchiveError('INVALID_INPUT', 'At least one --source is required');
  const eventId = command === 'read' ? identifier(v.event, '--event') : '';
  const after = command === 'export' ? cursorOf(Number(v.after ?? 0)) : 0;
  const limit = Number(v.limit ?? 500);
  if (command === 'export' && (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)) throw new ArchiveError('INVALID_INPUT', '--limit must be 1..10000');
  const view = viewOf(v.view ?? 'metadata');
  const capture = v.capture === undefined ? undefined : viewOf(v.capture);
  const configPath = command === 'config-check' || command === 'serve' || command === 'gc'
    ? identifier(v.config, '--config') : '';
  let result: unknown;
  if (command === 'serve') {
    const config = loadServiceConfig(configPath, { database: typeof v.db === 'string' ? v.db : undefined });
    const service = new TraceService(config, {
      onEvent: (event: ServiceEvent) => process.stdout.write(`${JSON.stringify(event)}\n`),
    });
    await service.start();
    await new Promise<void>(resolve => {
      let stopping = false;
      const shutdown = (reason: string): void => {
        if (stopping) return;
        stopping = true;
        void service.stop(reason).then(() => resolve(), error => {
          process.stderr.write(`${JSON.stringify({ error: { code: error instanceof ArchiveError ? error.code : 'STOP_FAILED', message: error instanceof Error ? error.message : 'Unknown stop error' } })}\n`);
          resolve();
        });
      };
      process.once('SIGINT', () => shutdown('SIGINT'));
      process.once('SIGTERM', () => shutdown('SIGTERM'));
    });
    return;
  }
  if (command === 'config-check') {
    const config = loadServiceConfig(configPath, { database: typeof v.db === 'string' ? v.db : undefined });
    result = describeServiceConfig(config);
  } else if (command === 'gc') {
    if (!configPath) throw new ArchiveError('INVALID_INPUT', 'gc requires --config: the blob directory comes from the service configuration');
    const config = loadServiceConfig(configPath, { database: typeof v.db === 'string' ? v.db : undefined });
    const archive = new Archive(config.database, undefined, config.content);
    try { result = archive.pruneOrphanBlobs({ dry_run: v['dry-run'] === true }); } finally { archive.close(); }
  } else {
    const archive = new Archive(v.db as string | undefined ?? defaultDatabase(), capture);
    try {
      switch (command) {
        case 'ingest': {
          const files = sourceFiles(sources!);
          let imported = 0, skipped = 0;
          const pending: string[] = [], errors: Array<{ path: string; code: string }> = [];
          for (const filename of files) {
            try {
              const report = archive.importFile(filename, instance, project, undefined, runtimeHint);
              imported += report.imported; skipped += report.skipped;
              if (report.pending) pending.push(filename);
            } catch (error) { errors.push({ path: filename, code: error instanceof ArchiveError ? error.code : 'SOURCE_ERROR' }); }
          }
          result = { archive_id: archive.archiveId, scanned: files.length, imported, skipped, pending, errors };
          if (errors.length) process.exitCode = 1;
          break;
        }
        case 'export': result = archive.exportBatch(after, limit, view); break;
        case 'read': result = { event: archive.readEvent(eventId, view) }; break;
        case 'delete-session': result = archive.deleteSession(runtime, instance, session); break;
        case 'status': result = archive.status(); break;
      }
    } finally { archive.close(); }
  }
  const output = `${JSON.stringify(result)}\n`;
  if (command === 'export' && typeof v.output === 'string') writeFileSync(v.output, output, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  else process.stdout.write(output);
}
try { await main(); }
catch (error) {
  process.stderr.write(`${JSON.stringify({ error: { code: error instanceof ArchiveError ? error.code : 'ERROR', message: error instanceof Error ? error.message : 'Unknown error' } })}\n`);
  process.exitCode = 1;
}
