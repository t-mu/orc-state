#!/usr/bin/env node
/**
 * cli/memory-search.ts
 * Usage: orc memory-search <query> [--wing=X] [--room=Y]
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../lib/paths.ts';
import { closeMemoryDb, searchMemory } from '../lib/memoryStore.ts';
import { flag } from '../lib/args.ts';

const query = process.argv.slice(2).find((a) => !a.startsWith('-'));

if (!query) {
  console.error('Usage: orc memory-search <query> [--wing=X] [--room=Y]');
  process.exit(1);
}

const dbPath = join(STATE_DIR, 'memory.db');
if (!existsSync(dbPath)) {
  console.log('Memory store not initialized (memory.db not found).');
  process.exit(0);
}

const wing = flag('wing');
const room = flag('room');

const results = searchMemory(STATE_DIR, {
  query,
  ...(wing ? { wing } : {}),
  ...(room ? { room } : {}),
});

if (results.length === 0) {
  console.log('No results found.');
  process.exit(0);
}

for (const r of results) {
  console.log(`[${r.id}] ${r.wing}/${r.hall}/${r.room} (importance=${r.importance})`);
  console.log(`  ${r.snippet}`);
}
closeMemoryDb();
