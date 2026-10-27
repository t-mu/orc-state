#!/usr/bin/env node
/**
 * cli/task-reset.ts
 * Usage: orc task-reset <task_ref> [--actor-id=<id>]
 *
 * Reset a task back to todo status and fail any active claims. In a
 * registered project the running coordinator applies it.
 */
import { flag } from '../lib/args.ts';
import { submitOperatorMutation } from '../lib/operatorMutations.ts';
import { cliError } from './shared.ts';

const taskRef = process.argv.slice(2).find((a) => !a.startsWith('-'));
const actorId = flag('actor-id') ?? 'human';

if (!taskRef) {
  console.error('Usage: orc task-reset <task_ref> [--actor-id=<id>]');
  process.exit(1);
}

try {
  const result = await submitOperatorMutation({ op: 'reset-task', task_ref: taskRef, actor_id: actorId });
  console.log(`task reset: ${taskRef} (was: ${String(result.previous_status)}, cancelled ${String(result.cancelled_claims)} active claims)`);
} catch (err) {
  cliError(err);
}
