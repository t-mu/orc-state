#!/usr/bin/env node
/**
 * cli/task-unblock.ts
 * Usage: orc task-unblock <task_ref> [--reason=<text>] [--actor-id=<id>]
 *
 * Change a blocked task back to todo status. In a registered project the
 * running coordinator applies it.
 */
import { flag } from '../lib/args.ts';
import { submitOperatorMutation } from '../lib/operatorMutations.ts';
import { cliError } from './shared.ts';

const taskRef = process.argv.slice(2).find((a) => !a.startsWith('-'));
const reason = flag('reason');
const actorId = flag('actor-id') ?? 'human';

if (!taskRef) {
  console.error('Usage: orc task-unblock <task_ref> [--reason=<text>] [--actor-id=<id>]');
  process.exit(1);
}

try {
  await submitOperatorMutation({ op: 'unblock-task', task_ref: taskRef, actor_id: actorId, ...(reason ? { reason } : {}) });
  console.log(`task unblocked: ${taskRef}`);
} catch (err) {
  cliError(err);
}
