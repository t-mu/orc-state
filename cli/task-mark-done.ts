#!/usr/bin/env node
/**
 * cli/task-mark-done.ts
 * Usage: orc task-mark-done <task_ref> [--actor-id=<id>]
 *
 * Sync a markdown-updated done task into orchestrator state.
 */
import { join } from 'node:path';
import { flag } from '../lib/args.ts';
import { withLock } from '../lib/lock.ts';
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { BACKLOG_DOCS_DIR, STATE_DIR } from '../lib/paths.ts';
import { readBacklog, findTask } from '../lib/stateReader.ts';
import { syncBacklogFromSpecs } from '../lib/backlogSync.ts';
import { assertTaskSpecStatus } from '../lib/taskAuthority.ts';

const taskRef = process.argv.slice(2).find((a) => !a.startsWith('-'));
const actorId = flag('actor-id') ?? 'human';

if (!taskRef) {
  console.error('Usage: orc task-mark-done <task_ref> [--actor-id=<id>]');
  process.exit(1);
}

try {
  withLock(join(STATE_DIR, '.lock'), () => {
    const now = new Date().toISOString();

    const beforeSync = readBacklog(STATE_DIR);
    const previousStatus = findTask(beforeSync, taskRef)?.status ?? 'unregistered';
    assertTaskSpecStatus(taskRef, 'done', BACKLOG_DOCS_DIR);
    syncBacklogFromSpecs(STATE_DIR, BACKLOG_DOCS_DIR, { lockAlreadyHeld: true });

    const synced = readBacklog(STATE_DIR);
    const task = findTask(synced, taskRef);
    if (!task) {
      throw new Error(`task not found after sync: ${taskRef}`);
    }

    appendSequencedEvent(
      STATE_DIR,
      {
        ts: now,
        event: 'task_updated',
        actor_type: actorId === 'human' ? 'human' : 'agent',
        actor_id: actorId,
        task_ref: taskRef,
        payload: { status: 'done', previous_status: previousStatus, fields: ['status'] },
      },
      { lockAlreadyHeld: true },
    );

    console.log(`task marked done: ${taskRef} (was: ${previousStatus})`);
  });
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
