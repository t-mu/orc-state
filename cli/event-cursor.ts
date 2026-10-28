#!/usr/bin/env node
/** Inspect or deliberately reset a named SQLite event consumer cursor. */
import { flag } from '../lib/args.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { runningCoordinatorPid } from '../lib/coordinatorLiveness.ts';
import { COORDINATOR_EVENT_CONSUMER, initializeEventOffset, readEventOffset, resetEventOffset } from '../lib/eventOffsets.ts';
import { cliError } from './shared.ts';

const consumer = flag('consumer') ?? COORDINATOR_EVENT_CONSUMER;
const resetTo = flag('reset-to');

try {
  if (!consumer.trim()) throw new Error('Consumer ID is required');
  if (resetTo !== null) {
    const seq = Number(resetTo);
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('--reset-to must be a non-negative safe integer');
    if (runningCoordinatorPid(STATE_DIR) !== null) throw new Error('Stop the coordinator before resetting an event cursor');
    initializeEventOffset(STATE_DIR, consumer);
    resetEventOffset(STATE_DIR, seq, consumer);
  } else {
    initializeEventOffset(STATE_DIR, consumer);
  }
  console.log(JSON.stringify({ consumer_id: consumer, last_event_seq: readEventOffset(STATE_DIR, consumer) }));
} catch (error) {
  cliError(error);
}
