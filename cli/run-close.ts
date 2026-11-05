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
import { USAGE } from './usage.ts';

const runId = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
const reason = flag('reason');
const actorId = flag('actor-id');

if (!runId) {
  console.error(`Usage: ${USAGE['run-close']}`);
  process.exit(1);
}

try {
  const result = await submitOperatorMutation({ op: 'run-close', run_id: runId, ...(actorId ? { actor_id: actorId } : {}), ...(reason ? { reason } : {}) });
  console.log(`run closed: ${runId} (task ${String(result.task_ref)})`);
  if (!result.worktree_cleaned) {
    console.log(result.branch_merged
      ? `warning: worktree/branch cleanup for ${runId} did not complete; see run-worktrees.json (orc run-info ${runId})`
      : `note: branch ${String(result.branch)} is not merged into main, so its worktree was kept; remove it by hand once nothing in it is needed (orc run-info ${runId})`);
  }
} catch (error) {
  cliError(error);
}
