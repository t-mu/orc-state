#!/usr/bin/env node
import { readPendingNotifications } from '../lib/masterNotifyQueue.ts';
import { flag } from '../lib/args.ts';
import { STATE_DIR } from '../lib/paths.ts';

const stateDir = flag('state-dir') ?? STATE_DIR;
const pending = readPendingNotifications(stateDir);

if (pending.length === 0) {
  console.log('No pending task notifications.');
  process.exit(0);
}

console.log(`${pending.length} pending task notification(s):\n`);
for (const notification of pending) {
  const n = notification as Record<string, unknown>;
  console.log(`  [${String(n.seq)}] ${String(n.type)}`);
  console.log(`        Task:    ${String(n.task_ref)}`);
  console.log(`        Worker:  ${String(n.agent_id)}`);
  console.log(`        Result:  ${n.success ? '✓ success' : '✗ failed'}`);
  if (n.failure_reason) {
    console.log(`        Reason:  ${typeof n.failure_reason === 'string' ? n.failure_reason : '(unknown)'}`);
  }
  if (n.exit_code !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    console.log(`        Exit:    ${String(n.exit_code)}`);
  }
  console.log(`        Time:    ${String(n.finished_at)}`);
  console.log('');
}
