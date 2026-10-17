#!/usr/bin/env node
/** Inspect or deliberately reset a named SQLite event consumer cursor. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flag } from '../lib/args.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { COORDINATOR_EVENT_CONSUMER, initializeEventOffset, readEventOffset, resetEventOffset } from '../lib/eventOffsets.ts';
import { cliError } from './shared.ts';

const consumer = flag('consumer') ?? COORDINATOR_EVENT_CONSUMER;
const resetTo = flag('reset-to');

try {
  if (!consumer.trim()) throw new Error('Consumer ID is required');
  if (resetTo !== null) {
    const seq = Number(resetTo);
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('--reset-to must be a non-negative safe integer');
    const pidFile = join(STATE_DIR, 'coordinator.pid');
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          throw new Error('Stop the coordinator before resetting an event cursor');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
    initializeEventOffset(STATE_DIR, consumer);
    resetEventOffset(STATE_DIR, seq, consumer);
  } else {
    initializeEventOffset(STATE_DIR, consumer);
  }
  console.log(JSON.stringify({ consumer_id: consumer, last_event_seq: readEventOffset(STATE_DIR, consumer) }));
} catch (error) {
  cliError(error);
}
