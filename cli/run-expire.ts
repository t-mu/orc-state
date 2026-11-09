#!/usr/bin/env node
/** Force-expire a claim and requeue its task. */
import { submitOperatorMutation } from '../lib/operatorDispatch.ts';
import { boolFlag } from '../lib/args.ts';
import { failCommand, printJson } from './shared.ts';
import { USAGE } from './usage.ts';

const json = boolFlag('json');
const runId = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
if (!runId) {
  console.error(`Usage: ${USAGE['run-expire']}`);
  process.exit(1);
}

try {
  const result = await submitOperatorMutation({ op: 'run-expire', run_id: runId });
  if (json) printJson(result);
  else console.log(`run expired: ${runId} (task ${String(result.task_ref)} requeued)`);
} catch (error) {
  await failCommand(error, json);
}
