import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task, Claim } from '../types/index.ts';

export function createTempStateDir(prefix = 'orch-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupTempStateDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Writes a minimal valid state directory: backlog.json (one 'orch' feature),
 * agents.json, claims.json, and an empty events.jsonl.
 */
export function seedState(
  dir: string,
  options: { tasks?: Task[]; claims?: Claim[] } = {}
): void {
  const { tasks = [], claims = [] } = options;
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{ ref: 'orch', title: 'Orch', tasks }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

export function readStateFile<T = unknown>(dir: string, filename: string): T {
  return JSON.parse(readFileSync(join(dir, filename), 'utf8')) as T;
}
