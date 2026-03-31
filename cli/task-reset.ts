#!/usr/bin/env node
/**
 * cli/task-reset.ts
 * Usage: orc task-reset <task_ref> [--actor-id=<id>]
 *
 * Reset a task back to todo status and fail any active claims.
 */
import { join } from 'node:path';
import { flag } from '../lib/args.ts';
import { withLock } from '../lib/lock.ts';
import { atomicWriteJson } from '../lib/atomicWrite.ts';
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { readBacklog, readClaims, findTask } from '../lib/stateReader.ts';
import { cliError } from './shared.ts';

const taskRef = process.argv.slice(2).find((a) => !a.startsWith('-'));
const actorId = flag('actor-id') ?? 'human';

if (!taskRef) {
  console.error('Usage: orc task-reset <task_ref> [--actor-id=<id>]');
  process.exit(1);
}

try {
  withLock(join(STATE_DIR, '.lock'), () => {
    const backlogPath = join(STATE_DIR, 'backlog.json');
    const claimsPath = join(STATE_DIR, 'claims.json');
    const now = new Date().toISOString();

    const backlog = readBacklog(STATE_DIR);
    const task = findTask(backlog, taskRef);
    if (!task) {
      throw new Error(`task not found: ${taskRef}`);
    }

    const previousStatus = task.status;
    task.status = 'todo';
    delete task.blocked_reason;
    delete task.requeue_eligible_after;
    task.updated_at = now;

    const claimsState = readClaims(STATE_DIR);
    const activeClaims = claimsState.claims.filter(
      (c) => c.task_ref === taskRef && (c.state === 'claimed' || c.state === 'in_progress'),
    );

    for (const c of activeClaims) {
      c.state = 'failed';
      c.failure_reason = 'manual_reset';
      c.finished_at = now;
    }

    atomicWriteJson(backlogPath, backlog);
    atomicWriteJson(claimsPath, claimsState);

    appendSequencedEvent(
      STATE_DIR,
      {
        ts: now,
        event: 'task_updated',
        actor_type: actorId === 'human' ? 'human' : 'agent',
        actor_id: actorId,
        task_ref: taskRef,
        payload: { reset: true, previous_status: previousStatus, status: 'todo' },
      },
      { lockAlreadyHeld: true },
    );

    console.log(`task reset: ${taskRef} (was: ${previousStatus}, cancelled ${activeClaims.length} active claims)`);
  });
} catch (err) {
  cliError(err);
}
