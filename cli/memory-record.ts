#!/usr/bin/env node
/**
 * cli/memory-record.ts
 * Usage: orc memory-record --content="..." [--wing=X] [--hall=Y] [--room=Z] [--importance=N]
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from '../lib/paths.ts';
import { closeMemoryDb, storeDrawer } from '../lib/memoryStore.ts';
import { flag, intFlag } from '../lib/args.ts';

export function recordMemory(stateDir: string, opts: {
  content: string;
  wing?: string | null;
  hall?: string | null;
  room?: string | null;
  importance?: number;
}): number {
  const dbPath = join(stateDir, 'memory.db');
  if (!existsSync(dbPath)) {
    console.log('Memory store not initialized (memory.db not found).');
    return 0;
  }
  const id = storeDrawer(stateDir, {
    content: opts.content,
    wing: opts.wing ?? 'general',
    hall: opts.hall ?? 'default',
    room: opts.room ?? 'default',
    ...(opts.importance !== undefined ? { importance: opts.importance } : {}),
  });
  console.log(`stored: drawer ${id}`);
  closeMemoryDb();
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const content = flag('content');
  if (!content) {
    console.error('Usage: orc memory-record --content="..." [--wing=X] [--hall=Y] [--room=Z] [--importance=N]');
    process.exit(1);
  }
  const wing = flag('wing');
  const hall = flag('hall');
  const room = flag('room');
  const importance = intFlag('importance', 5);
  process.exit(recordMemory(STATE_DIR, { content, wing, hall, room, importance }));
}
