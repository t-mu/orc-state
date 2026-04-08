#!/usr/bin/env node
/**
 * cli/memory-wake-up.ts
 * Usage: orc memory-wake-up [--wing=X] [--budget=N]
 *
 * Exits 0 with empty output when memory.db doesn't exist (non-fatal for worker bootstrap).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../lib/paths.ts';
import { closeMemoryDb, memoryWakeUp } from '../lib/memoryStore.ts';
import { flag, intFlag } from '../lib/args.ts';

const dbPath = join(STATE_DIR, 'memory.db');
if (!existsSync(dbPath)) {
  process.exit(0);
}

const wing = flag('wing');
const budget = intFlag('budget', 800);

const text = memoryWakeUp(STATE_DIR, {
  ...(wing ? { wing } : {}),
  tokenBudget: budget,
});

if (text) {
  console.log(text);
}
closeMemoryDb();
