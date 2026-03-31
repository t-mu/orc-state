#!/usr/bin/env node
/**
 * cli/task-unblock.ts
 * Usage: orc task-unblock <task_ref> [--reason=<text>]
 *
 * Change a blocked task back to todo status.
 */
import { join } from 'node:path';
import { flag } from '../lib/args.ts';
import { withLock } from '../lib/lock.ts';
import { atomicWriteJson } from '../lib/atomicWrite.ts';
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { readBacklog, findTask } from '../lib/stateReader.ts';
import { cliError } from './shared.ts';

const taskRef = process.argv.slice(2).find((a) => !a.startsWith('-'));
const reason = flag('reason');

if (!taskRef) {
  console.error('Usage: orc task-unblock <task_ref> [--reason=<text>]');
  process.exit(1);
}

try {
  withLock(join(STATE_DIR, '.lock'), () => {
    const backlogPath = join(STATE_DIR, 'backlog.json');
    const now = new Date().toISOString();

    const backlog = readBacklog(STATE_DIR);
    const task = findTask(backlog, taskRef);
    if (!task) {
      throw new Error(`task not found: ${taskRef}`);
    }

    if (task.status !== 'blocked') {
      throw new Error(`task is not blocked (status: ${task.status}): ${taskRef}`);
    }

    task.status = 'todo';
    delete task.blocked_reason;
    task.updated_at = now;

    atomicWriteJson(backlogPath, backlog);

    appendSequencedEvent(
      STATE_DIR,
      {
        ts: now,
        event: 'task_updated',
        actor_type: 'human',
        actor_id: 'human',
        task_ref: taskRef,
        payload: { status: 'todo', previous_status: 'blocked', unblocked: true, ...(reason ? { reason } : {}) },
      },
      { lockAlreadyHeld: true },
    );

    console.log(`task unblocked: ${taskRef}`);
  });
} catch (err) {
  cliError(err);
}
