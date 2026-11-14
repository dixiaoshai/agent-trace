import { existsSync } from 'node:fs';
import path from 'node:path';

/** Prefer the canonical location; keep existing pre-rename archives accessible. */
export function defaultDatabase(directory = process.cwd()): string {
  const current = path.join(directory, '.agent-trace', 'trace.sqlite');
  const legacy = path.join(directory, '.agent-archive', 'archive.sqlite');
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}
