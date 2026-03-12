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
  console.log(`  [${n.seq}] ${n.type}`);
  console.log(`        Task:    ${n.task_ref}`);
  console.log(`        Worker:  ${n.agent_id}`);
  console.log(`        Result:  ${n.success ? '✓ success' : '✗ failed'}`);
  if (n.failure_reason) {
    console.log(`        Reason:  ${n.failure_reason}`);
  }
  if (n.exit_code !== undefined) {
    console.log(`        Exit:    ${n.exit_code}`);
  }
  console.log(`        Time:    ${n.finished_at}`);
  console.log('');
}
