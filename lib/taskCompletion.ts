import { join } from 'node:path';
import { withLock } from './lock.ts';
import { appendSequencedEvent } from './eventLog.ts';
import { readBacklog, findTask } from './stateReader.ts';
import { STATE_DIR } from './paths.ts';
import { commitBacklog, projectTaskStoreFor } from './projectTasks.ts';
import { ConflictError, NotFoundError } from './domainErrors.ts';

const NON_COMPLETABLE_STATUSES = new Set(['blocked', 'released', 'cancelled']);

export function markTaskDoneRuntimeOnly(
  taskRef: string,
  actorId = 'human',
  stateDir = STATE_DIR,
): { previousStatus: string } {
  return withLock(join(stateDir, '.lock'), () => {
    const now = new Date().toISOString();

    const backlog = readBacklog(stateDir);
    const task = findTask(backlog, taskRef);
    const previousStatus = task?.status ?? 'unregistered';
    if (!task) {
      throw new NotFoundError(`task not found: ${taskRef}`);
    }
    if (NON_COMPLETABLE_STATUSES.has(task.status)) {
      throw new ConflictError(`task ${taskRef} cannot transition to done from status ${task.status}`);
    }

    if (task.status !== 'done') {
      task.status = 'done';
      task.updated_at = now;
      delete task.blocked_reason;
      // Recorded once per completion: the status guard above makes a repeated confirmation a no-op.
      const runId = projectTaskStoreFor(stateDir)?.activeRunId(taskRef) ?? null;
      commitBacklog(stateDir, backlog, { [taskRef]: { cause: 'merge_succeeded', actorId, runId } });
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

    return { previousStatus };
  });
}
