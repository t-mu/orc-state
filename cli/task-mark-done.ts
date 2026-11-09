#!/usr/bin/env node
/**
 * cli/task-mark-done.ts
 * Usage: orc task-mark-done <task_ref> [--actor-id=<id>] [--json]
 *
 * Runtime-only task completion. The coordinator uses this after a successful
 * merge to mark the shared backlog state done. Task status is runtime-owned;
 * no Markdown spec mirrors it.
 */
import { boolFlag, flag } from '../lib/args.ts';
import { submitOperatorMutation } from '../lib/operatorDispatch.ts';
import { failCommand, printJson } from './shared.ts';
import { USAGE } from './usage.ts';

const taskRef = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
const actorId = flag('actor-id');
const json = boolFlag('json');

if (!taskRef) {
  console.error(`Usage: ${USAGE['task-mark-done']}`);
  process.exit(1);
}

try {
  const result = await submitOperatorMutation({ op: 'task-mark-done', task_ref: taskRef, ...(actorId ? { actor_id: actorId } : {}) });
  if (json) printJson(result);
  else console.log(`task marked done: ${taskRef} (was: ${String(result.previous_status)})`);
} catch (err) {
  await failCommand(err, json);
}
