#!/usr/bin/env node
/**
 * cli/task-reset.ts
 * Usage: orc task-reset <task_ref> [--actor-id=<id>] [--json]
 *
 * Reset a task back to todo status and fail any active claims. In a
 * registered project the running coordinator applies it.
 */
import { parseCommandArgsOrExit } from '../lib/args.ts';
import { submitOperatorMutation } from '../lib/operatorDispatch.ts';
import { failCommand, printJson } from './shared.ts';
import { USAGE } from './usage.ts';

const { values, positionals } = parseCommandArgsOrExit(USAGE['task-reset'], { 'actor-id': { type: 'string' }, json: { type: 'boolean' } }, process.argv.slice(2), 1);
const taskRef = positionals[0];
// Without --actor-id the coordinator records the caller: the operator as human, a master session as the master.
const actorId = values['actor-id'];
const json = values.json === true;

if (!taskRef) {
  console.error(`Usage: ${USAGE['task-reset']}`);
  process.exit(1);
}

try {
  const result = await submitOperatorMutation({ op: 'reset-task', task_ref: taskRef, ...(actorId ? { actor_id: actorId } : {}) });
  if (json) printJson(result);
  else console.log(`task reset: ${taskRef} (was: ${String(result.previous_status)}, cancelled ${String(result.cancelled_claims)} active claims)`);
} catch (err) {
  await failCommand(err, json);
}
