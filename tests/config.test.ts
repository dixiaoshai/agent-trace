import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { describeServiceConfig, loadServiceConfig, projectForCwd } from '../src/config.ts';
import { hashToken } from '../src/api.ts';
import type { SourceConfig } from '../src/config.ts';

const STATS_TOKEN = 'synthetic-metadata-token-value';
const KNOWLEDGE_TOKEN = 'synthetic-content-token-value!!';
const statsHash = createHash('sha256').update(STATS_TOKEN).digest('hex');
const knowledgeHash = createHash('sha256').update(KNOWLEDGE_TOKEN).digest('hex');

function directory(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-trace-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function validConfig(): Record<string, unknown> {
  return {
    schema_version: 1,
    database: 'state/trace.sqlite',
    capture_mode: 'content',
    collection: {
      enabled: true,
      scan_interval_seconds: 15,
      backfill: 'all',
      sources: [
        {
          instance_id: 'workstation-a',
          root: 'logs/codex',
          projects: [
            { project_id: 'demo', cwd_allowlist: ['projects/demo'] },
            { project_id: 'other', cwd_allowlist: ['/opt/projects/other'] },
          ],
        },
      ],
    },
    api: {
      enabled: true,
      host: '127.0.0.1',
      port: 8766,
      clients: [
        { id: 'agent-stats', views: ['metadata'], token_sha256: statsHash },
        { id: 'agent-knowledge', views: ['content'], token_sha256: knowledgeHash },
      ],
    },
  };
}

function writeConfig(dir: string, value: unknown, name = 'service.json'): string {
  const filename = path.join(dir, name);
  writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify(value));
  return filename;
}

test('service config resolves paths relative to the config file and applies explicit values', t => {
  const dir = directory(t);
  const filename = writeConfig(dir, validConfig());
  const config = loadServiceConfig(filename);
  assert.equal(config.config_path, filename);
  assert.equal(config.database, path.join(dir, 'state/trace.sqlite'));
  assert.equal(config.capture_mode, 'content');
  assert.equal(config.collection.enabled, true);
  assert.equal(config.collection.scan_interval_seconds, 15);
  assert.equal(config.collection.backfill, 'all');
  assert.equal(config.collection.sources[0]!.root, path.join(dir, 'logs/codex'));
  assert.deepEqual(config.collection.sources[0]!.projects[0]!.cwd_allowlist, [path.join(dir, 'projects/demo')]);
  assert.deepEqual(config.api.clients.map(client => client.id), ['agent-stats', 'agent-knowledge']);
  assert.deepEqual(config.api.clients[1]!.views, ['content']);
  assert.equal(config.api.clients[0]!.token_sha256, statsHash);
  const described = describeServiceConfig(config);
  const serialized = JSON.stringify(described);
  assert.doesNotMatch(serialized, new RegExp(statsHash));
  assert.doesNotMatch(serialized, new RegExp(knowledgeHash));
  assert.match(serialized, /agent-stats/);
});


test('omitted service values use safe defaults, config-dir database fallback and legacy compatibility', t => {
  const dir = directory(t);
  const minimal = {
    schema_version: 1,
    collection: { enabled: false, sources: [] },
    api: { enabled: false },
  };
  const config = loadServiceConfig(writeConfig(dir, minimal));
  assert.equal(config.database, path.join(dir, '.agent-trace', 'trace.sqlite'));
  assert.equal(config.capture_mode, 'metadata');
  assert.equal(config.collection.scan_interval_seconds, 30);
  assert.equal(config.collection.backfill, 'none');
  assert.equal(config.api.host, '127.0.0.1');
  assert.equal(config.api.port, 8766);
  assert.deepEqual(config.api.clients, []);

  mkdirSync(path.join(dir, '.agent-archive'));
  writeFileSync(path.join(dir, '.agent-archive', 'archive.sqlite'), '');
  assert.equal(loadServiceConfig(path.join(dir, 'service.json')).database, path.join(dir, '.agent-archive', 'archive.sqlite'));
  mkdirSync(path.join(dir, '.agent-trace'));
  writeFileSync(path.join(dir, '.agent-trace', 'trace.sqlite'), '');
  assert.equal(loadServiceConfig(path.join(dir, 'service.json')).database, path.join(dir, '.agent-trace', 'trace.sqlite'));

  const explicit = loadServiceConfig(path.join(dir, 'service.json'), { database: 'override.sqlite' });
  assert.equal(explicit.database, path.join(process.cwd(), 'override.sqlite'));
  const absolute = path.join(dir, 'absolute.sqlite');
  assert.equal(loadServiceConfig(path.join(dir, 'service.json'), { database: absolute }).database, absolute);
});

test('service config rejects unsafe or ambiguous values with INVALID_CONFIG', t => {
  const dir = directory(t);
  const cases: Array<[string, (config: Record<string, any>) => unknown]> = [
    ['schema version', c => { c.schema_version = 2; return c; }],
    ['unknown top-level key', c => { c.extra = true; return c; }],
    ['missing collection', c => { delete c.collection; return c; }],
    ['unknown collection key', c => { c.collection.extra = 1; return c; }],
    ['non-boolean collection enabled', c => { c.collection.enabled = 'yes'; return c; }],
    ['empty sources while enabled', c => { c.collection.sources = []; return c; }],
    ['bad scan interval', c => { c.collection.scan_interval_seconds = 0; return c; }],
    ['fractional scan interval', c => { c.collection.scan_interval_seconds = 1.5; return c; }],
    ['unknown backfill', c => { c.collection.backfill = 'some'; return c; }],
    ['source unknown key', c => { c.collection.sources[0].extra = 1; return c; }],
    ['source missing instance', c => { delete c.collection.sources[0].instance_id; return c; }],
    ['source empty root', c => { c.collection.sources[0].root = ''; return c; }],
    ['source home-relative root', c => { c.collection.sources[0].root = '~/codex'; return c; }],
    ['source without projects', c => { c.collection.sources[0].projects = []; return c; }],
    ['fallback duplicates project id', c => { c.collection.sources[0].unmatched_project_id = 'demo'; return c; }],
    ['non-string fallback project id', c => { c.collection.sources[0].unmatched_project_id = 1; return c; }],
    ['empty fallback project id', c => { c.collection.sources[0].unmatched_project_id = ''; return c; }],
    ['duplicate project in source', c => { c.collection.sources[0].projects.push(structuredClone(c.collection.sources[0].projects[0])); return c; }],
    ['duplicate root', c => { c.collection.sources.push(structuredClone(c.collection.sources[0])); return c; }],
    ['empty cwd allowlist', c => { c.collection.sources[0].projects[0].cwd_allowlist = []; return c; }],
    ['non-string cwd', c => { c.collection.sources[0].projects[0].cwd_allowlist = [1]; return c; }],
    ['non-loopback host', c => { c.api.host = '0.0.0.0'; return c; }],
    ['remote host', c => { c.api.host = 'example.com'; return c; }],
    ['bad port', c => { c.api.port = 0; return c; }],
    ['string port', c => { c.api.port = '8766'; return c; }],
    ['enabled API without clients', c => { c.api.clients = []; return c; }],
    ['unknown client key', c => { c.api.clients[0].extra = true; return c; }],
    ['missing token', c => { delete c.api.clients[0].token_sha256; return c; }],
    ['short token hash', c => { c.api.clients[0].token_sha256 = 'abcd'; return c; }],
    ['duplicate client id', c => { c.api.clients[1].id = c.api.clients[0].id; return c; }],
    ['duplicate token hash', c => { c.api.clients[1].token_sha256 = c.api.clients[0].token_sha256; return c; }],
    ['empty client views', c => { c.api.clients[0].views = []; return c; }],
    ['unknown client view', c => { c.api.clients[0].views = ['both']; return c; }],
    ['repeated client view', c => { c.api.clients[0].views = ['metadata', 'metadata']; return c; }],
  ];
  for (const [name, mutate] of cases) {
    const filename = writeConfig(dir, mutate(validConfig()), `${name.replace(/[^a-z]+/g, '-')}.json`);
    assert.throws(() => loadServiceConfig(filename), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'INVALID_CONFIG', name);
      return true;
    }, name);
  }
});

test('service config rejects malformed files and oversized input', t => {
  const dir = directory(t);
  assert.throws(() => loadServiceConfig(path.join(dir, 'missing.json')), /cannot read/);
  assert.throws(() => loadServiceConfig(writeConfig(dir, '{broken', 'broken.json')), /invalid JSON/);
  assert.throws(() => loadServiceConfig(writeConfig(dir, '[]', 'array.json')), /must be a JSON object/);
  const huge = path.join(dir, 'huge.json');
  writeFileSync(huge, ' '.repeat(1024 * 1024 + 1));
  assert.throws(() => loadServiceConfig(huge), /exceeds/);
});

test('project matching honors path boundaries, nesting and ambiguity', () => {
  const source: SourceConfig = {
    instance_id: 'device',
    root: '/logs',
    runtime: 'auto',
    projects: [
      { project_id: 'work', cwd_allowlist: ['/tmp/work'] },
      { project_id: 'nested', cwd_allowlist: ['/tmp/work/nested'] },
      { project_id: 'other', cwd_allowlist: ['/opt/other/'] },
    ],
  };
  assert.deepEqual(projectForCwd(source, '/tmp/work'), { project_id: 'work' });
  assert.deepEqual(projectForCwd(source, '/tmp/work/demo/'), { project_id: 'work' });
  assert.deepEqual(projectForCwd(source, '/tmp/work/a/../nested/pkg'), { project_id: 'nested' });
  assert.deepEqual(projectForCwd(source, '/opt/other'), { project_id: 'other' });
  assert.equal((projectForCwd(source, '/tmp/workshop') as { error: string }).error, 'PROJECT_UNMATCHED');
  assert.equal((projectForCwd(source, 'tmp/work') as { error: string }).error, 'PROJECT_UNMATCHED');
  assert.equal((projectForCwd(source, '') as { error: string }).error, 'PROJECT_UNMATCHED');
  assert.equal((projectForCwd(source, undefined) as { error: string }).error, 'PROJECT_UNMATCHED');
  const ambiguous: SourceConfig = {
    instance_id: 'device', root: '/logs', runtime: 'auto',
    projects: [
      { project_id: 'a', cwd_allowlist: ['/tmp/shared'] },
      { project_id: 'b', cwd_allowlist: ['/tmp/shared'] },
    ],
  };
  assert.equal((projectForCwd(ambiguous, '/tmp/shared/x') as { error: string }).error, 'PROJECT_AMBIGUOUS');
});

test('unmatched_project_id collects everything while declared projects keep precise attribution', t => {
  const dir = directory(t);
  const value = validConfig();
  const source = (value.collection as { sources: Array<Record<string, unknown>> }).sources[0]!;
  source.unmatched_project_id = 'unscoped';
  const config = loadServiceConfig(writeConfig(dir, value));
  assert.equal(config.collection.sources[0]!.unmatched_project_id, 'unscoped');
  assert.equal(
    (describeServiceConfig(config).collection as { sources: Array<{ unmatched_project_id: string | null }> })
      .sources[0]!.unmatched_project_id,
    'unscoped',
  );

  // A source with no declared projects is valid only together with the fallback.
  source.projects = [];
  const collectAll = loadServiceConfig(writeConfig(dir, value, 'collect-all.json'));
  assert.deepEqual(collectAll.collection.sources[0]!.projects, []);
  assert.equal(collectAll.collection.sources[0]!.unmatched_project_id, 'unscoped');

  const fallbackSource: SourceConfig = {
    instance_id: 'device',
    root: '/logs',
    runtime: 'auto',
    unmatched_project_id: 'unscoped',
    projects: [
      { project_id: 'work', cwd_allowlist: ['/tmp/work'] },
      { project_id: 'nested', cwd_allowlist: ['/tmp/work/nested'] },
    ],
  };
  // Declared scopes still win: the fallback only covers what cannot be attributed.
  assert.deepEqual(projectForCwd(fallbackSource, '/tmp/work/demo'), { project_id: 'work' });
  assert.deepEqual(projectForCwd(fallbackSource, '/tmp/work/nested/pkg'), { project_id: 'nested' });
  assert.deepEqual(projectForCwd(fallbackSource, '/tmp/elsewhere'), { project_id: 'unscoped' });
  assert.deepEqual(projectForCwd(fallbackSource, '/tmp/workshop'), { project_id: 'unscoped' });
  assert.deepEqual(projectForCwd(fallbackSource, 'tmp/work'), { project_id: 'unscoped' });
  assert.deepEqual(projectForCwd(fallbackSource, ''), { project_id: 'unscoped' });
  assert.deepEqual(projectForCwd(fallbackSource, undefined), { project_id: 'unscoped' });
  // Ambiguity is a configuration error, not an unknown project, so it stays an error.
  const ambiguous: SourceConfig = { ...fallbackSource, projects: [
    { project_id: 'a', cwd_allowlist: ['/tmp/shared'] },
    { project_id: 'b', cwd_allowlist: ['/tmp/shared'] },
  ] };
  assert.equal((projectForCwd(ambiguous, '/tmp/shared/x') as { error: string }).error, 'PROJECT_AMBIGUOUS');
});

test('token hashing is stable and config-check is side-effect free', t => {
  assert.equal(hashToken(STATS_TOKEN), statsHash);
  assert.equal(hashToken(KNOWLEDGE_TOKEN), knowledgeHash);
  const dir = directory(t);
  const filename = writeConfig(dir, validConfig());
  const cli = path.resolve('src/cli.ts');
  const output = execFileSync(process.execPath, [cli, 'config-check', '--config', filename], { encoding: 'utf8' });
  const parsed = JSON.parse(output);
  assert.equal(parsed.database, path.join(dir, 'state/trace.sqlite'));
  assert.deepEqual(parsed.api.clients, [
    { id: 'agent-stats', views: ['metadata'] },
    { id: 'agent-knowledge', views: ['content'] },
  ]);
  assert.doesNotMatch(output, new RegExp(statsHash));
  assert.equal(existsSync(parsed.database), false);
  const overridden = path.join(dir, 'override.sqlite');
  assert.equal(JSON.parse(execFileSync(process.execPath, [cli, 'config-check', '--config', filename, '--db', overridden], { encoding: 'utf8' })).database, overridden);
  assert.equal(existsSync(overridden), false);
  const invalid = writeConfig(dir, { schema_version: 1, collection: { enabled: true, sources: [] }, api: { enabled: false } }, 'invalid.json');
  assert.throws(() => execFileSync(process.execPath, [cli, 'config-check', '--config', invalid], { encoding: 'utf8', stdio: 'pipe' }));
});

test('checked-in service example stays valid and does not enable collection or the API', () => {
  const config = loadServiceConfig(path.resolve('agent-trace.service.example.json'));
  assert.equal(config.collection.enabled, false);
  assert.equal(config.api.enabled, false);
  assert.equal(config.capture_mode, 'metadata');
  assert.deepEqual(config.api.clients.map(client => client.views), [['metadata'], ['content']]);
});

test('checked-in content example uses a separate database, explicit projects and closed collection', () => {
  const config = loadServiceConfig(path.resolve('agent-trace.content.example.json'));
  assert.equal(config.capture_mode, 'content');
  assert.equal(config.collection.enabled, false);
  assert.equal(config.api.enabled, false);
  assert.equal(config.content.max_inline_bytes, 65536);
  assert.equal(config.content.blob_directory, '/absolute/path/to/content-state/blobs');
  assert.notEqual(path.basename(config.database), 'trace.sqlite');
  assert.deepEqual(config.collection.sources.map(source => source.runtime), ['codex', 'codex', 'pi', 'dsh']);
  const projects = new Set(config.collection.sources.flatMap(source => source.projects.map(project => project.project_id)));
  assert.deepEqual([...projects].sort(), ['agent-knowledge', 'agent-stats', 'agent-trace']);
  assert.deepEqual(config.api.clients.map(client => client.views), [['content']]);
});

test('source runtime defaults to auto and accepts codex, pi or dsh explicitly', t => {
  const dir = directory(t);
  const value = validConfig();
  const source = (value.collection as { sources: Array<Record<string, unknown>> }).sources[0]!;
  const defaults = loadServiceConfig(writeConfig(dir, value, 'auto.json'));
  assert.equal(defaults.collection.sources[0]!.runtime, 'auto');
  assert.equal((describeServiceConfig(defaults).collection as { sources: Array<{ runtime: string }> }).sources[0]!.runtime, 'auto');

  source.runtime = 'pi';
  const pi = loadServiceConfig(writeConfig(dir, value, 'pi.json'));
  assert.equal(pi.collection.sources[0]!.runtime, 'pi');
  source.runtime = 'codex';
  assert.equal(loadServiceConfig(writeConfig(dir, value, 'codex.json')).collection.sources[0]!.runtime, 'codex');
  source.runtime = 'dsh';
  assert.equal(loadServiceConfig(writeConfig(dir, value, 'dsh.json')).collection.sources[0]!.runtime, 'dsh');
  // The product name is accepted as an alias and stored as the canonical id.
  source.runtime = 'deepseek-harness';
  assert.equal(loadServiceConfig(writeConfig(dir, value, 'deepseek.json')).collection.sources[0]!.runtime, 'dsh');

  for (const invalid of ['deepseek', '', 1, null]) {
    source.runtime = invalid;
    assert.throws(() => loadServiceConfig(writeConfig(dir, value, 'bad.json')), /must be "auto", "codex", "pi" or "dsh"/);
  }
});
