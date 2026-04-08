#!/usr/bin/env node
/**
 * cli/memory-search.ts
 * Usage: orc memory-search <query> [--wing=X] [--room=Y]
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from '../lib/paths.ts';
import { closeMemoryDb, searchMemory } from '../lib/memoryStore.ts';
import { flag } from '../lib/args.ts';

export function runMemorySearch(stateDir: string, query: string, opts: { wing?: string | null; room?: string | null } = {}): number {
  const dbPath = join(stateDir, 'memory.db');
  if (!existsSync(dbPath)) {
    console.log('Memory store not initialized (memory.db not found).');
    return 0;
  }
  const results = searchMemory(stateDir, {
    query,
    ...(opts.wing ? { wing: opts.wing } : {}),
    ...(opts.room ? { room: opts.room } : {}),
  });
  if (results.length === 0) {
    console.log('No results found.');
    closeMemoryDb();
    return 0;
  }
  for (const r of results) {
    console.log(`[${r.id}] ${r.wing}/${r.hall}/${r.room} (importance=${r.importance})`);
    console.log(`  ${r.snippet}`);
  }
  closeMemoryDb();
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const query = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!query) {
    console.error('Usage: orc memory-search <query> [--wing=X] [--room=Y]');
    process.exit(1);
  }
  const wing = flag('wing');
  const room = flag('room');
  process.exit(runMemorySearch(STATE_DIR, query, { wing, room }));
}
