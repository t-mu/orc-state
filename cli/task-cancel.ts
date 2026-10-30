#!/usr/bin/env node
/**
 * cli/task-cancel.ts
 * Usage: orc task-cancel <task_ref> [--reason=<text>] [--actor-id=<id>]
 *
 * Cancel a task that is not yet terminal, ending any active run. In a
 * registered project the running coordinator applies it; the operator can
 * cancel without the master.
 */
import { flag } from '../lib/args.ts';
import { submitOperatorMutation } from '../lib/operatorDispatch.ts';
import { cliError } from './shared.ts';

const taskRef = process.argv.slice(2).find((a) => !a.startsWith('-'));
const reason = flag('reason');
const actorId = flag('actor-id');

if (!taskRef) {
  console.error('Usage: orc task-cancel <task_ref> [--reason=<text>] [--actor-id=<id>]');
  process.exit(1);
}

try {
  const result = await submitOperatorMutation({ op: 'cancel-task', task_ref: taskRef, ...(actorId ? { actor_id: actorId } : {}), ...(reason ? { reason } : {}) });
  // An already-terminal task is reported, not thrown, by the shared implementation.
  if (typeof result.error === 'string') {
    console.error(`task not cancelled: ${taskRef} (${result.error}${typeof result.status === 'string' ? `, status ${result.status}` : ''})`);
    process.exit(1);
  }
  console.log(`task cancelled: ${taskRef} (status: ${String(result.status)})`);
} catch (err) {
  cliError(err);
}
