#!/usr/bin/env node
/**
 * cli/memory-status.ts
 * Usage: orc memory-status
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from '../lib/paths.ts';
import { closeMemoryDb, getMemoryStats, listWings } from '../lib/memoryStore.ts';

export function printMemoryStatus(stateDir: string): number {
  const dbPath = join(stateDir, 'memory.db');
  if (!existsSync(dbPath)) {
    console.log('Memory store not initialized (memory.db not found).');
    return 0;
  }
  const stats = getMemoryStats(stateDir);
  const wings = listWings(stateDir);
  console.log(`Drawers: ${stats.totalDrawers}`);
  console.log(`Wings:   ${stats.distinctWings}`);
  console.log(`Rooms:   ${stats.distinctRooms}`);
  console.log(`DB size: ${(stats.dbSizeBytes / 1024).toFixed(1)} KB`);
  if (stats.oldestMemory) console.log(`Oldest:  ${stats.oldestMemory}`);
  if (stats.newestMemory) console.log(`Newest:  ${stats.newestMemory}`);
  if (wings.length > 0) {
    console.log('\nWing breakdown:');
    for (const w of wings) {
      console.log(`  ${w.wing}: ${w.count}`);
    }
  }
  closeMemoryDb();
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(printMemoryStatus(STATE_DIR));
}
