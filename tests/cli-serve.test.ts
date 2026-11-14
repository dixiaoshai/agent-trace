import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import path from 'node:path';
import test from 'node:test';
import { Archive } from '../src/store.ts';
import { acquireCollectionLease, ensureCollectionSchema } from '../src/collector.ts';
import {
  fixtureLog,
  loadConfig,
  temporaryDirectory,
  waitFor,
  writeServiceConfig,
} from './support.ts';

function ndjson(output: string): Array<Record<string, any>> {
  return output.split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

test('serve CLI stops cleanly on SIGTERM, releases its lease and reports NDJSON state', async t => {
  const dir = temporaryDirectory(t);
  const project = path.join(dir, 'project');
  const logs = path.join(dir, 'logs');
  mkdirSync(project, { recursive: true });
  mkdirSync(logs, { recursive: true });
  writeFileSync(path.join(logs, 'session.jsonl'), fixtureLog(project));
  const configFile = writeServiceConfig(dir, {
    database: 'state/trace.sqlite',
    captureMode: 'content',
    collection: {
      enabled: true,
      scan_interval_seconds: 1,
      backfill: 'all',
      sources: [{
        instance_id: 'signal-device',
        root: 'logs',
        projects: [{ project_id: 'demo', cwd_allowlist: ['project'] }],
      }],
    },
    api: { enabled: false },
  });
  const config = loadConfig(configFile);
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(process.execPath, [path.resolve('src/cli.ts'), 'serve', '--config', configFile], {
    cwd: path.resolve('.'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });

  await waitFor(async () => ndjson(output).some(event => event.type === 'serve.started') || null);
  const scan = await waitFor(async () => ndjson(output).find(event => event.type === 'collection.scan' && event.imported === 11) ?? null);
  assert.equal(scan.state, 'idle');

  child.kill('SIGTERM');
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  assert.equal(exit.code, 0, stderr);
  const events = ndjson(output);
  assert.ok(events.some(event => event.type === 'serve.started'));
  assert.ok(events.some(event => event.type === 'serve.stopped' && event.reason === 'SIGTERM'));

  const archive = new Archive(config.database, config.capture_mode);
  try {
    assert.equal(archive.highWatermark(), 11);
    ensureCollectionSchema(archive.db);
    assert.equal(acquireCollectionLease(archive.db, 'after-cli-stop', 10_000).acquired, true);
  } finally { archive.close(); }
});
