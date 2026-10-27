#!/usr/bin/env node
/**
 * cli/memory-record.ts
 * Usage: orc memory-record --content="..." [--wing=X] [--hall=Y] [--room=Z] [--importance=N]
 */
import { clientCredential } from '../lib/sessionCredentials.ts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVE_PROJECT, STATE_DIR } from '../lib/paths.ts';
import { closeMemoryDb } from '../lib/memoryStore.ts';
import { flag, intFlag } from '../lib/args.ts';
import { applyLifecycle } from '../lib/workerLifecycle.ts';
import { submitLifecycle } from '../lib/lifecycleDispatch.ts';
import { cliError } from './shared.ts';

export function recordMemory(stateDir: string, opts: {
  content: string;
  wing?: string | null;
  hall?: string | null;
  room?: string | null;
  importance?: number;
}): number {
  console.log(applyLifecycle(stateDir, { op: 'memory-record', ...opts }).message);
  closeMemoryDb();
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const content = flag('content');
  if (!content) {
    console.error('Usage: orc memory-record --content="..." [--wing=X] [--hall=Y] [--room=Z] [--importance=N]');
    process.exit(1);
  }
  const opts = { content, wing: flag('wing'), hall: flag('hall'), room: flag('room'), importance: intFlag('importance', 5) };
  // A session (worker or master) records through its coordinator; an operator shell writes directly.
  if (ACTIVE_PROJECT && clientCredential()) {
    try {
      console.log((await submitLifecycle({ op: 'memory-record', ...opts })).message);
    } catch (error) {
      cliError(error);
    }
  } else {
    process.exit(recordMemory(STATE_DIR, opts));
  }
}
