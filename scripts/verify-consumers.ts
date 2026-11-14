/** Real archive + real consumer CLI integration, exclusively synthetic inputs. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Archive } from '../src/store.ts';
import type { Batch } from '../src/types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const plugins = path.dirname(root.replace(/\/$/, ''));
const temporary = mkdtempSync(path.join(os.tmpdir(), 'shared-agent-acceptance-'));
const statsDir = path.join(plugins, 'agent-stats');
const knowledgeDir = path.join(plugins, 'agent-knowledge');
const statsDb = path.join(temporary, 'stats.sqlite');
const config = path.join(temporary, 'agent-knowledge.json');
const selectedSource = path.join(temporary, 'selected.jsonl');
copyFileSync(path.join(root, 'fixtures/codex/demo.jsonl'), selectedSource);
mkdirSync(path.join(temporary, 'documents'));
writeFileSync(config, JSON.stringify({ schema_version: 1, database: './knowledge.sqlite', allowed_project_ids: ['demo'], sources: [{ id: 'docs', root: './documents', project_id: 'demo' }] }));
const archive = new Archive(path.join(temporary, 'archive.sqlite'), 'content');
const stats = (args: string[]): any => JSON.parse(execFileSync('python3', ['-m', 'agent_stats', '--db', statsDb, ...args], { cwd: statsDir, encoding: 'utf8' }));
const knowledge = (args: string[]): any => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'src/interfaces/cli.ts', ...args, '--config', config], { cwd: knowledgeDir, encoding: 'utf8' }));
let fileNumber = 0;
function consume(batch: Batch, target: 'stats' | 'knowledge'): any {
  const filename = path.join(temporary, `page-${fileNumber++}.json`);
  writeFileSync(filename, JSON.stringify(batch), { mode: 0o600 });
  return target === 'stats' ? stats(['import-archive', '--input', filename]) : knowledge(['archive-import', '--input', filename]);
}
try {
  const report = archive.importFile(selectedSource, 'acceptance-device', 'demo');
  assert.equal(report.imported, 11);
  assert.equal(archive.importFile(selectedSource, 'acceptance-device', 'demo').imported, 0);
  let statsCursor = 0, knowledgeCursor = 0;
  // Different page sizes prove consumer cursors and persistence are independent.
  let more = true;
  while (more) {
    const batch = archive.exportBatch(statsCursor, 3, 'metadata');
    const result = consume(batch, 'stats');
    statsCursor = result.cursor; more = batch.has_more;
    assert.equal(consume(batch, 'stats').replayed, true);
  }
  more = true;
  while (more) {
    const batch = archive.exportBatch(knowledgeCursor, 4, 'content');
    const result = consume(batch, 'knowledge');
    knowledgeCursor = result.cursor; more = batch.has_more;
    assert.equal(consume(batch, 'knowledge').replayed, true);
  }
  unlinkSync(selectedSource);
  const summary = stats(['summary']).summary;
  assert.equal(summary.sessions, 1); assert.equal(summary.turns, 1);
  assert.equal(summary.token_total, 140); assert.equal(summary.tool_calls, 1);
  assert.doesNotMatch(readFileSync(statsDb).toString(), /SYNTHETIC_PRIVATE|SYNTHETIC_FUTURE/);
  const found = knowledge(['archive-search', '--query', '幂等键', '--project', 'demo']).evidence;
  assert.ok(found.length > 0);
  const reference = found[0];
  const evidence = knowledge(['archive-read', '--archive', reference.archive_id, '--event', reference.event.event_id, '--project', 'demo']);
  assert.ok(evidence.event.source.record_hash);
  assert.equal(knowledge(['search', '--query', '幂等键', '--project', 'demo']).results.length, 0);
  archive.deleteSession('codex', 'acceptance-device', 'archive-demo-session');
  statsCursor = consume(archive.exportBatch(statsCursor, 100, 'metadata'), 'stats').cursor;
  knowledgeCursor = consume(archive.exportBatch(knowledgeCursor, 100, 'content'), 'knowledge').cursor;
  assert.equal(stats(['summary']).summary.sessions, 0);
  assert.equal(knowledge(['archive-search', '--query', '幂等键', '--project', 'demo']).evidence.length, 0);
  assert.equal(statsCursor, knowledgeCursor);
  process.stdout.write(JSON.stringify({ passed: true, synthetic_only: true, imported_events: report.imported,
    before_delete: { sessions: summary.sessions, turns: summary.turns, token_total: summary.token_total, tool_calls: summary.tool_calls },
    independent_cursors: true, duplicate_pages: true, evidence_after_source_removal: true, statistics_metadata_only: true,
    evidence_separate_from_confirmed_knowledge: true, deletion_propagated: true }) + '\n');
} finally { archive.close(); rmSync(temporary, { recursive: true, force: true }); }
