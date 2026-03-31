#!/usr/bin/env node
/**
 * cli/run-expire.ts
 * Usage: orc run-expire <run_id>
 *
 * Force-expire a specific claim and requeue its task.
 */
import { join } from 'node:path';
import { withLock } from '../lib/lock.ts';
import { atomicWriteJson } from '../lib/atomicWrite.ts';
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { readBacklog, readClaims, findTask } from '../lib/stateReader.ts';
import { cliError } from './shared.ts';

const runId = process.argv.slice(2).find((a) => !a.startsWith('-'));

if (!runId) {
  console.error('Usage: orc run-expire <run_id>');
  process.exit(1);
}

try {
  withLock(join(STATE_DIR, '.lock'), () => {
    const backlogPath = join(STATE_DIR, 'backlog.json');
    const claimsPath = join(STATE_DIR, 'claims.json');
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

    task.status = 'todo';
    task.updated_at = now;

    atomicWriteJson(claimsPath, claimsState);
    atomicWriteJson(backlogPath, backlog);

    appendSequencedEvent(
      STATE_DIR,
      {
        ts: now,
        event: 'claim_expired',
        actor_type: 'human',
        actor_id: 'human',
        run_id: runId,
        task_ref: claim.task_ref,
        agent_id: claim.agent_id,
        payload: { reason: 'manual_expire', policy: 'requeue' },
      },
      { lockAlreadyHeld: true },
    );

    console.log(`run expired: ${runId} (task ${claim.task_ref} requeued)`);
  });
} catch (err) {
  cliError(err);
}
