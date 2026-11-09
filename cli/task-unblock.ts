#!/usr/bin/env node
/**
 * cli/task-unblock.ts
 * Usage: orc task-unblock <task_ref> [--reason=<text>] [--actor-id=<id>] [--json]
 *
 * Change a blocked task back to todo status. In a registered project the
 * running coordinator applies it.
 */
import { boolFlag, flag } from '../lib/args.ts';
import { submitOperatorMutation } from '../lib/operatorDispatch.ts';
import { failCommand, printJson } from './shared.ts';
import { USAGE } from './usage.ts';

const taskRef = process.argv.slice(2).find((a) => !a.startsWith('-'));
const reason = flag('reason');
const actorId = flag('actor-id');
const json = boolFlag('json');

if (!taskRef) {
  console.error(`Usage: ${USAGE['task-unblock']}`);
  process.exit(1);
}

try {
  const result = await submitOperatorMutation({ op: 'unblock-task', task_ref: taskRef, ...(actorId ? { actor_id: actorId } : {}), ...(reason ? { reason } : {}) });
  if (json) printJson(result);
  else console.log(`task unblocked: ${taskRef}`);
} catch (err) {
  await failCommand(err, json);
}
