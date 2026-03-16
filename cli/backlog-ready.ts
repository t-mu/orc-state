#!/usr/bin/env node
/**
 * cli/backlog-ready.ts
 * Usage: orc backlog-ready [--json]
 *
 * List tasks that are todo + all dependencies done/released + planning_state=ready_for_dispatch.
 */
import { STATE_DIR } from '../lib/paths.ts';
import { readBacklog } from '../lib/stateReader.ts';
import { listDispatchReadyTasks } from '../lib/statusView.ts';

const asJson = process.argv.includes('--json');

const backlog = readBacklog(STATE_DIR);
const ready = listDispatchReadyTasks(backlog);

if (asJson) {
  console.log(JSON.stringify(ready, null, 2));
  process.exit(0);
}

console.log(`Dispatch-Ready Tasks (${ready.length}):`);
if (ready.length === 0) {
  console.log('  (none)');
  process.exit(0);
}

for (const task of ready) {
  console.log(`  ${task.ref.padEnd(36)} [${task.priority}]  ${task.title}`);
}
