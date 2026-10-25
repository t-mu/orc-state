#!/usr/bin/env node
/**
 * cli/run-expire.ts
 * Usage: orc run-expire <run_id>
 *
 * Force-expire a specific claim and requeue its task.
 */
import { join } from 'node:path';
import { withLock } from '../lib/lock.ts';
import { commitClaims } from '../lib/runStore.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { readBacklog, readClaims, findTask } from '../lib/stateReader.ts';
import { cliError } from './shared.ts';
import { commitBacklog } from '../lib/projectTasks.ts';

const runId = process.argv.slice(2).find((a) => !a.startsWith('-'));

if (!runId) {
  console.error('Usage: orc run-expire <run_id>');
  process.exit(1);
}

try {
  withLock(join(STATE_DIR, '.lock'), () => {
    const now = new Date().toISOString();

    const claimsState = readClaims(STATE_DIR);
    const claim = claimsState.claims.find((c) => c.run_id === runId);

    if (!claim) {
      throw new Error(`run not found: ${runId}`);
    }

    if (claim.state === 'done' || claim.state === 'failed') {
      throw new Error(`run is already terminal (state: ${claim.state}): ${runId}`);
    }

    const backlog = readBacklog(STATE_DIR);
    const task = findTask(backlog, claim.task_ref);
    if (!task) {
      throw new Error(`task not found for run: ${claim.task_ref}`);
    }

    if (task.status === 'done' || task.status === 'released' || task.status === 'cancelled') {
      throw new Error(`task is already terminal (status: ${task.status}): ${claim.task_ref}`);
    }

    claim.state = 'failed';
    claim.failure_reason = 'manual_expire';
    claim.finished_at = now;
    claim.finalization_state = null;
    claim.finalization_retry_count = 0;
    claim.finalization_blocked_reason = null;

    task.status = 'todo';
    task.updated_at = now;

    commitClaims(STATE_DIR, claimsState, [{
        ts: now,
        event: 'claim_expired',
        actor_type: 'human',
        actor_id: 'human',
        run_id: runId,
        task_ref: claim.task_ref,
        agent_id: claim.agent_id,
        payload: { reason: 'manual_expire', policy: 'requeue' },
      }]);
    commitBacklog(STATE_DIR, backlog, { [claim.task_ref]: { cause: 'failure_requeue', runId, actorId: 'human', reason: 'manual_expire' } });

    console.log(`run expired: ${runId} (task ${claim.task_ref} requeued)`);
  });
} catch (err) {
  cliError(err);
}
