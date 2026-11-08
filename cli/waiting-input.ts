#!/usr/bin/env node
/**
 * cli/waiting-input.ts
 * Usage: orc waiting-input [--json]
 *
 * Show all claims currently awaiting input, with the question text.
 */
import { STATE_DIR } from '../lib/paths.ts';
import { readClaims } from '../lib/stateReader.ts';
import { listWaitingInput } from '../lib/waitingInput.ts';
import { boolFlag } from '../lib/args.ts';

const asJson = boolFlag('json');
const rows = listWaitingInput(STATE_DIR, readClaims(STATE_DIR).claims);

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

console.log(`Waiting for Input (${rows.length} runs):`);
if (rows.length === 0) {
  console.log('  (none)');
  process.exit(0);
}

for (const r of rows) {
  console.log(`  ${r.run_id}  agent=${r.agent_id}  task=${r.task_ref}  waiting=${r.waiting_seconds ?? '?'}s`);
  if (r.question) {
    console.log(`    question: ${r.question}`);
  }
}
