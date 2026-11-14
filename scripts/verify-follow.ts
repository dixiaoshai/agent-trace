/**
 * Real-process end-to-end check for the follow workers.
 *
 * Starts agent-trace `serve` (API only), the real Python Agent Stats follow
 * worker and the real TypeScript Agent Knowledge follow worker against a
 * temporary content archive. It never reads user logs: the source is the
 * synthetic Codex fixture, and every database/port is temporary.
 *
 * Override sibling worktrees when validating unmerged branches:
 *   AGENT_STATS_DIR=... AGENT_KNOWLEDGE_DIR=... npm run verify:follow
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const plugins = path.dirname(root);
const statsDir = process.env.AGENT_STATS_DIR ?? path.join(plugins, 'agent-stats');
const knowledgeDir = process.env.AGENT_KNOWLEDGE_DIR ?? path.join(plugins, 'agent-knowledge');
const traceCli = path.join(root, 'src/cli.ts');
const fixture = path.join(root, 'fixtures/codex/demo.jsonl');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'agent-trace-follow-'));
const keep = process.env.VERIFY_KEEP === '1';
const STATS_TOKEN = 'synthetic-stats-follow-token';
const KNOWLEDGE_TOKEN = 'synthetic-knowledge-follow-token';
const EXTRA_EVENT = `${JSON.stringify({
  timestamp: '2026-01-01T00:00:11Z',
  type: 'event_msg',
  payload: { type: 'user_message', turn_id: 'turn-2', message: 'synthetic appended event' },
})}\n`;
const traceDb = path.join(temporary, 'trace.sqlite');
const statsDb = path.join(temporary, 'stats.sqlite');
const knowledgeDb = path.join(temporary, 'knowledge.sqlite');
const source = path.join(temporary, 'selected.jsonl');
const statsFollowConfig = path.join(temporary, 'stats-follow.json');
const knowledgeFollowConfig = path.join(temporary, 'knowledge-follow.json');
const knowledgeConfig = path.join(temporary, 'knowledge.json');
const traceConfig = path.join(temporary, 'trace.json');
const children: Array<{ name: string; child: ChildProcess; output: () => string }> = [];

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function stats(...args: string[]): any {
  return JSON.parse(execFileSync('python3', ['-m', 'agent_stats', '--db', statsDb, ...args], {
    cwd: statsDir, encoding: 'utf8',
  }));
}

function knowledge(...args: string[]): any {
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'src/interfaces/cli.ts', ...args, '--config', knowledgeConfig], {
    cwd: knowledgeDir, encoding: 'utf8',
  }));
}

function statsCursor(): number {
  const output = execFileSync('python3', ['-c',
    'import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);r=c.execute("select max(cursor) from archive_cursors").fetchone();print(r[0] or 0)',
    statsDb], { encoding: 'utf8' });
  return Number(output.trim());
}

function ingest(): void {
  const result = JSON.parse(execFileSync(process.execPath, [traceCli, 'ingest', '--source', source,
    '--instance', 'e2e-device', '--project', 'demo', '--capture', 'content', '--db', traceDb], {
    cwd: root, encoding: 'utf8',
  }));
  assert.equal(result.errors.length, 0, JSON.stringify(result));
}

function start(name: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): void {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr!.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.on('error', error => { output += `\nspawn error: ${error.message}`; });
  children.push({ name, child, output: () => output });
}

async function stop(name: string): Promise<void> {
  const index = children.findIndex(entry => entry.name === name);
  assert.ok(index >= 0, `unknown child ${name}`);
  const entry = children.splice(index, 1)[0]!;
  if (entry.child.exitCode !== null) return;
  const exited = new Promise<number | null>(resolve => entry.child.once('exit', code => resolve(code)));
  entry.child.kill('SIGTERM');
  const timeout = new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 8000));
  const result = await Promise.race([exited, timeout]);
  if (result === 'timeout') {
    entry.child.kill('SIGKILL');
    throw new Error(`${name} did not stop on SIGTERM\n${entry.output()}`);
  }
  assert.equal(result, 0, `${name} exited ${result}\n${entry.output()}`);
}

async function waitFor(label: string, probe: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { if (await probe()) return; } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const detail = children.map(entry => `--- ${entry.name}\n${entry.output()}`).join('\n');
  throw new Error(`timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}\n${detail}`);
}

async function status(): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/status`, { headers: { Authorization: `Bearer ${KNOWLEDGE_TOKEN}` } });
  assert.equal(response.status, 200);
  return response.json();
}

let port = 0;

try {
  mkdirSync(path.join(temporary, 'docs'));
  copyFileSync(fixture, source);
  port = await freePort();
  writeFileSync(traceConfig, JSON.stringify({
    schema_version: 1, database: traceDb, capture_mode: 'content',
    collection: { enabled: false, sources: [] },
    api: {
      enabled: true, host: '127.0.0.1', port,
      clients: [
        { id: 'agent-stats', views: ['metadata'], token_sha256: sha(STATS_TOKEN) },
        { id: 'agent-knowledge', views: ['content'], token_sha256: sha(KNOWLEDGE_TOKEN) },
      ],
    },
  }));
  writeFileSync(statsFollowConfig, JSON.stringify({
    schema_version: 1, trace_url: `http://127.0.0.1:${port}`, token_env: 'TRACE_STATS_TOKEN',
    database: statsDb, page_size: 3, idle_seconds: 1, request_timeout_seconds: 5, max_backoff_seconds: 5,
  }));
  writeFileSync(knowledgeConfig, JSON.stringify({
    schema_version: 1, database: knowledgeDb, allowed_project_ids: ['demo'],
    sources: [{ id: 'docs', root: './docs', project_id: 'demo' }],
  }));
  writeFileSync(knowledgeFollowConfig, JSON.stringify({
    schema_version: 1, trace_url: `http://127.0.0.1:${port}`, token_env: 'TRACE_KNOWLEDGE_TOKEN',
    config: knowledgeConfig, page_size: 2, idle_seconds: 1, request_timeout_seconds: 5, max_backoff_seconds: 5,
  }));
  ingest();

  start('trace', process.execPath, [traceCli, 'serve', '--config', traceConfig], root);
  await waitFor('trace API', async () => {
    try { return (await status()).archive.high_watermark === 11; } catch { return false; }
  });

  start('stats', 'python3', ['-m', 'agent_stats', 'follow', '--config', statsFollowConfig], statsDir,
    { TRACE_STATS_TOKEN: STATS_TOKEN });
  start('knowledge', process.execPath, ['--import', 'tsx', 'src/interfaces/cli.ts', 'follow', '--config', knowledgeFollowConfig], knowledgeDir,
    { TRACE_KNOWLEDGE_TOKEN: KNOWLEDGE_TOKEN });

  await waitFor('both consumers to catch up', () => {
    const summary = stats('summary').summary;
    const evidence = knowledge('archive-search', '--query', 'SYNTHETIC_PRIVATE_RESULT', '--project', 'demo').evidence;
    return summary.sessions === 1 && summary.token_total === 140 && summary.tool_calls === 1 && evidence.length >= 1;
  });
  assert.equal(statsCursor(), 11);
  const baselineTurns = stats('summary').summary.turns;

  // Append a line: both independent cursors advance without manual batches.
  appendFileSync(source, EXTRA_EVENT);
  ingest();
  await waitFor('incremental delivery to both consumers', () => {
    const evidence = knowledge('archive-search', '--query', 'synthetic appended event', '--project', 'demo').evidence;
    return evidence.length === 1 && statsCursor() === 12;
  });

  // Stopping Stats must not stop Trace or Knowledge; its committed cursor stays behind.
  await stop('stats');
  assert.equal(statsCursor(), 12);
  appendFileSync(source, EXTRA_EVENT);
  ingest();
  await waitFor('Knowledge continues while Stats is stopped', () => {
    const evidence = knowledge('archive-search', '--query', 'synthetic appended event', '--project', 'demo').evidence;
    return evidence.length === 2;
  });
  assert.equal(statsCursor(), 12);
  assert.equal(stats('summary').summary.token_total, 140);

  start('stats', 'python3', ['-m', 'agent_stats', 'follow', '--config', statsFollowConfig], statsDir,
    { TRACE_STATS_TOKEN: STATS_TOKEN });
  await waitFor('Stats to catch up after restart', () => statsCursor() === 13);
  const afterRestart = stats('summary').summary;
  assert.equal(afterRestart.sessions, 1);
  assert.equal(afterRestart.token_total, 140);
  assert.equal(afterRestart.tool_calls, 1);
  assert.ok(afterRestart.turns >= baselineTurns);
  // Metadata may keep bounded prompt titles; tool bodies must never reach Stats.
  assert.doesNotMatch(readFileSync(statsDb).toString(), /SYNTHETIC_PRIVATE|SYNTHETIC_FUTURE/);

  // Stopping Knowledge must not stop Trace or Stats; restarting resumes its own cursor.
  await stop('knowledge');
  appendFileSync(source, EXTRA_EVENT);
  ingest();
  await waitFor('Stats continues while Knowledge is stopped', () => statsCursor() === 14);
  assert.equal(knowledge('archive-search', '--query', 'synthetic appended event', '--project', 'demo').evidence.length, 2);
  start('knowledge', process.execPath, ['--import', 'tsx', 'src/interfaces/cli.ts', 'follow', '--config', knowledgeFollowConfig], knowledgeDir,
    { TRACE_KNOWLEDGE_TOKEN: KNOWLEDGE_TOKEN });
  await waitFor('Knowledge to catch up after restart', () =>
    knowledge('archive-search', '--query', 'synthetic appended event', '--project', 'demo').evidence.length === 3);

  // With both consumers stopped, Trace still ingests and serves; an offline
  // consumer obtains the missed page later without duplicate evidence.
  await stop('stats');
  await stop('knowledge');
  appendFileSync(source, EXTRA_EVENT);
  ingest();
  assert.equal((await status()).archive.high_watermark, 15);
  start('knowledge', process.execPath, ['--import', 'tsx', 'src/interfaces/cli.ts', 'follow', '--config', knowledgeFollowConfig], knowledgeDir,
    { TRACE_KNOWLEDGE_TOKEN: KNOWLEDGE_TOKEN });
  await waitFor('offline Knowledge to backfill', () =>
    knowledge('archive-search', '--query', 'synthetic appended event', '--project', 'demo').evidence.length === 4);
  const evidence = knowledge('archive-search', '--query', 'synthetic appended event', '--project', 'demo', '--limit', '20').evidence;
  const ids = new Set(evidence.map((item: any) => item.event.event_id));
  assert.equal(ids.size, evidence.length, 'duplicate evidence after restart');

  await stop('knowledge');
  await stop('trace');
  process.stdout.write(`${JSON.stringify({
    passed: true,
    synthetic_only: true,
    trace_high_watermark: 15,
    stats: { sessions: afterRestart.sessions, turns: afterRestart.turns, tokens: afterRestart.token_total, tools: afterRestart.tool_calls },
    knowledge_appended_events: evidence.length,
    independent_stop_and_resume: true,
    terminal_cursor: statsCursor(),
  })}\n`);
} finally {
  for (const entry of [...children]) {
    entry.child.kill('SIGKILL');
  }
  if (!keep) rmSync(temporary, { recursive: true, force: true });
  else process.stdout.write(`kept ${temporary}\n`);
}
