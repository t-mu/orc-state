#!/usr/bin/env node
/**
 * cli/run-close.ts
 * Usage: orc run-close <run_id> [--reason=<text>] [--actor-id=<id>]
 *
 * Close a run whose work was merged by hand (the task is done/released or its
 * branch is merged into main): record the claim done, emit run_finished and
 * clean the run worktree and branch. In a registered project the running
 * coordinator applies it.
 */
import { flag } from '../lib/args.ts';
import { submitOperatorMutation } from '../lib/operatorDispatch.ts';
import { cliError } from './shared.ts';

const runId = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
const reason = flag('reason');
const actorId = flag('actor-id');

if (!runId) {
  console.error('Usage: orc run-close <run_id> [--reason=<text>] [--actor-id=<id>]');
  process.exit(1);
}

try {
  const result = await submitOperatorMutation({ op: 'run-close', run_id: runId, ...(actorId ? { actor_id: actorId } : {}), ...(reason ? { reason } : {}) });
  console.log(`run closed: ${runId} (task ${String(result.task_ref)})`);
  if (!result.worktree_cleaned) console.log(`warning: worktree/branch cleanup for ${runId} did not complete; see run-worktrees.json`);
  if (result.task_status !== 'done' && result.task_status !== 'released') {
    console.log(`note: task ${String(result.task_ref)} is ${String(result.task_status)}; mark it done with orc task-mark-done ${String(result.task_ref)}`);
  }
} catch (error) {
  cliError(error);
}
