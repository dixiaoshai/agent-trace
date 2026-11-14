#!/usr/bin/env node
/**
 * Install the long-running content-capture services for one macOS user.
 *
 * - `local.agent-trace-content`  : `agent-trace serve` with a `content` config
 * - `local.agent-knowledge-follow` (optional): Knowledge's follow worker, so
 *   captured pages keep flowing into the evidence database without babysitting.
 *
 * The installer never enables capture by itself: the config must already be
 * `capture_mode: "content"` and have collection enabled. It prunes blob files
 * that no committed event cites before starting the service, then leaves both
 * jobs to launchd (`RunAtLoad` + `KeepAlive`).
 *
 * Usage:
 *   node --experimental-strip-types scripts/install-content-service.ts [options]
 *     --config PATH          service config (default ~/.local/share/agent-trace/content.json)
 *     --token-file PATH      API token for the Knowledge client (default ~/.local/share/agent-trace/content.token)
 *     --knowledge-follow P   Knowledge follow config (default ~/.local/share/agent-knowledge/content.follow.json)
 *     --knowledge-dir PATH   Knowledge checkout (default ../agent-knowledge)
 *     --no-knowledge         install only the Trace content service
 *     --uninstall            stop and remove both jobs
 *     --dry-run              print the plan without touching launchd
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const TRACE_LABEL = 'local.agent-trace-content';
const KNOWLEDGE_LABEL = 'local.agent-knowledge-follow';
const NODE = process.execPath;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(file: string, args: string[], capture = true): { code: number; out: string; err: string } {
  const result = spawnSync(file, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  return { code: result.status ?? 1, out: result.stdout ?? '', err: result.stderr ?? '' };
}

function check(what: string, result: { code: number; err: string }): void {
  if (result.code !== 0) fail(`${what} failed: ${result.err.trim() || `exit ${result.code}`}`);
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function loaded(label: string): boolean {
  return run('/bin/launchctl', ['print', `${domain()}/${label}`]).code === 0;
}

/** Write a plist through plutil so escaping and format are Apple's problem. */
function writePlist(label: string, value: Record<string, unknown>, target: string): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-trace-plist-'));
  try {
    const json = path.join(dir, 'service.json');
    writeFileSync(json, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    const pending = `${target}.pending`;
    check(`plutil ${label}`, run('/usr/bin/plutil', ['-convert', 'xml1', '-o', pending, json]));
    chmodSync(pending, 0o600);
    check(`plutil -lint ${label}`, run('/usr/bin/plutil', ['-lint', pending]));
    check(`install ${label}`, run('/bin/mv', ['-f', pending, target]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function bootout(label: string): void {
  if (!loaded(label)) return;
  check(`launchctl bootout ${label}`, run('/bin/launchctl', ['bootout', `${domain()}/${label}`]));
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!loaded(label)) return;
    execFileSync('/bin/sleep', ['0.1']);
  }
  fail(`${label} did not stop`);
}

function bootstrap(label: string, target: string): void {
  check(`launchctl enable ${label}`, run('/bin/launchctl', ['enable', `${domain()}/${label}`]));
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = run('/bin/launchctl', ['bootstrap', domain(), target]);
    if (result.code === 0 || loaded(label)) return;
    execFileSync('/bin/sleep', ['0.25']);
  }
  fail(`launchctl bootstrap ${label} failed`);
}

/** Create the log file (0600) without truncating the previous run. */
function touch(file: string): void {
  appendFileSync(file, '', { mode: 0o600 });
  chmodSync(file, 0o600);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      'token-file': { type: 'string' },
      'knowledge-follow': { type: 'string' },
      'knowledge-dir': { type: 'string' },
      'no-knowledge': { type: 'boolean' },
      uninstall: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (process.platform !== 'darwin') fail('This installer requires macOS');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const home = os.homedir();
  const traceState = path.join(home, '.local/share/agent-trace');
  const knowledgeState = path.join(home, '.local/share/agent-knowledge');
  const agents = path.join(home, 'Library/LaunchAgents');
  const config = path.resolve(values.config ?? path.join(traceState, 'content.json'));
  const tokenFile = path.resolve(values['token-file'] ?? path.join(traceState, 'content.token'));
  const followConfig = path.resolve(values['knowledge-follow'] ?? path.join(knowledgeState, 'content.follow.json'));
  const knowledgeDir = path.resolve(values['knowledge-dir'] ?? path.join(root, '..', 'agent-knowledge'));
  const dryRun = values['dry-run'] === true;
  const withKnowledge = values['no-knowledge'] !== true;

  const tracePlist = path.join(agents, `${TRACE_LABEL}.plist`);
  const knowledgePlist = path.join(agents, `${KNOWLEDGE_LABEL}.plist`);

  if (values.uninstall === true) {
    if (dryRun) {
      process.stdout.write(`Would remove ${TRACE_LABEL}${withKnowledge ? ` and ${KNOWLEDGE_LABEL}` : ''}\n`);
      return;
    }
    bootout(TRACE_LABEL);
    bootout(KNOWLEDGE_LABEL);
    for (const file of [tracePlist, knowledgePlist]) if (existsSync(file)) rmSync(file);
    process.stdout.write('Removed the content capture jobs; databases and logs are untouched.\n');
    return;
  }

  if (!existsSync(config)) fail(`Missing content service config: ${config}`);
  const describe = run(NODE, ['--experimental-strip-types', path.join(root, 'src/cli.ts'),
    'config-check', '--config', config]);
  check('config-check', describe);
  const described = JSON.parse(describe.out) as { capture_mode: string; collection: { enabled: boolean; backfill: string } };
  if (described.capture_mode !== 'content') fail(`${config} is not a content capture config`);
  if (!described.collection.enabled) fail(`${config} has collection.enabled = false`);

  const traceLog = path.join(traceState, 'content.log');
  const traceErr = path.join(traceState, 'content.err');
  if (!dryRun) {
    touch(traceLog);
    touch(traceErr);
  }
  const traceJob = {
    Label: TRACE_LABEL,
    ProgramArguments: [NODE, '--experimental-strip-types', path.join(root, 'src/cli.ts'), 'serve', '--config', config],
    WorkingDirectory: traceState,
    EnvironmentVariables: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 30,
    ProcessType: 'Background',
    StandardOutPath: traceLog,
    StandardErrorPath: traceErr,
  };

  let knowledgeJob: Record<string, unknown> | null = null;
  if (withKnowledge) {
    const cli = path.join(knowledgeDir, 'dist/interfaces/cli.js');
    if (!existsSync(cli)) fail(`Knowledge build missing: ${cli} (run npm run build in ${knowledgeDir}, or pass --no-knowledge)`);
    if (!existsSync(followConfig)) fail(`Missing Knowledge follow config: ${followConfig} (or pass --no-knowledge)`);
    if (!existsSync(tokenFile)) fail(`Missing API token file: ${tokenFile} (or pass --no-knowledge)`);
    const follow = JSON.parse(readFileSync(followConfig, 'utf8')) as { token_env?: string };
    if (!follow.token_env) fail(`${followConfig} does not declare token_env`);
    const token = readFileSync(tokenFile, 'utf8').trim();
    if (!token) fail(`Empty API token: ${tokenFile}`);
    if (!dryRun) {
      touch(path.join(knowledgeState, 'follow.log'));
      touch(path.join(knowledgeState, 'follow.err'));
    }
    knowledgeJob = {
      Label: KNOWLEDGE_LABEL,
      ProgramArguments: [NODE, cli, 'follow', '--config', followConfig],
      WorkingDirectory: knowledgeDir,
      EnvironmentVariables: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', [follow.token_env]: token },
      RunAtLoad: true,
      KeepAlive: true,
      ThrottleInterval: 30,
      ProcessType: 'Background',
      StandardOutPath: path.join(knowledgeState, 'follow.log'),
      StandardErrorPath: path.join(knowledgeState, 'follow.err'),
    };
  }

  if (dryRun) {
    // Never echo the API token, even in a plan.
    const redacted = knowledgeJob && {
      ...knowledgeJob,
      EnvironmentVariables: Object.fromEntries(Object.entries(knowledgeJob.EnvironmentVariables as Record<string, string>)
        .map(([key, value]) => [key, key === 'PATH' ? value : '<redacted>'])),
    };
    process.stdout.write(`${JSON.stringify({ trace: traceJob, knowledge: redacted ?? null }, null, 2)}\n`);
    return;
  }

  // Stop first: gc must not race a scan that is still writing blobs.
  bootout(TRACE_LABEL);
  bootout(KNOWLEDGE_LABEL);
  check('blob gc', run(NODE, ['--experimental-strip-types', path.join(root, 'src/cli.ts'), 'gc', '--config', config]));
  writePlist(TRACE_LABEL, traceJob, tracePlist);
  bootstrap(TRACE_LABEL, tracePlist);
  if (knowledgeJob) {
    writePlist(KNOWLEDGE_LABEL, knowledgeJob, knowledgePlist);
    bootstrap(KNOWLEDGE_LABEL, knowledgePlist);
  }
  process.stdout.write([
    `Started ${TRACE_LABEL} (content capture)`,
    knowledgeJob ? `Started ${KNOWLEDGE_LABEL} (Trace -> Knowledge follow)` : 'Knowledge follow not installed',
    `Trace log: ${traceLog}`,
    `Knowledge log: ${path.join(knowledgeState, 'follow.log')}`,
    '',
  ].join('\n'));
}

main();
