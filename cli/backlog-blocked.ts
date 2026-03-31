#!/usr/bin/env node
/**
 * cli/backlog-blocked.ts
 * Usage: orc backlog-blocked [--json]
 *
 * List all tasks with status === 'blocked'.
 */
import { STATE_DIR } from '../lib/paths.ts';
import { readBacklog } from '../lib/stateReader.ts';
import { boolFlag } from '../lib/args.ts';

const asJson = boolFlag('json');

const backlog = readBacklog(STATE_DIR);
const blocked: Array<{ ref: string; title: string; blocked_reason: string | null; feature_ref: string }> = [];

for (const feature of backlog.features ?? []) {
  for (const task of feature.tasks ?? []) {
    if (task.status === 'blocked') {
      blocked.push({
        ref: task.ref,
        title: task.title,
        blocked_reason: task.blocked_reason ?? null,
        feature_ref: feature.ref,
      });
    }
  }
}

if (asJson) {
  console.log(JSON.stringify(blocked, null, 2));
  process.exit(0);
}

console.log(`Blocked Tasks (${blocked.length}):`);
if (blocked.length === 0) {
  console.log('  (none)');
  process.exit(0);
}

for (const task of blocked) {
  console.log(`  ${task.ref.padEnd(36)} ${task.title}`);
  console.log(`    reason: ${task.blocked_reason ?? '(no reason)'}`);
}
