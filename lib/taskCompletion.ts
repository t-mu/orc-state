import { join } from 'node:path';
import { withLock } from './lock.ts';
import { atomicWriteJson } from './atomicWrite.ts';
import { appendSequencedEvent } from './eventLog.ts';
import { readBacklog, findTask } from './stateReader.ts';
import { STATE_DIR } from './paths.ts';

const NON_COMPLETABLE_STATUSES = new Set(['blocked', 'released', 'cancelled']);

export function markTaskDoneRuntimeOnly(
  taskRef: string,
  actorId = 'human',
  stateDir = STATE_DIR,
): void {
  withLock(join(stateDir, '.lock'), () => {
    const now = new Date().toISOString();
    const backlogPath = join(stateDir, 'backlog.json');

    const backlog = readBacklog(stateDir);
    const task = findTask(backlog, taskRef);
    const previousStatus = task?.status ?? 'unregistered';
    if (!task) {
      throw new Error(`task not found: ${taskRef}`);
    }
    if (NON_COMPLETABLE_STATUSES.has(task.status)) {
      throw new Error(`task ${taskRef} cannot transition to done from status ${task.status}`);
    }

    if (task.status !== 'done') {
      task.status = 'done';
      task.updated_at = now;
      delete task.blocked_reason;
      atomicWriteJson(backlogPath, backlog);
    }

    appendSequencedEvent(
      stateDir,
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
}
