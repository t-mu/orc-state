#!/usr/bin/env node
import { readPendingNotifications } from '../lib/masterNotifyQueue.mjs';
import { flag } from '../lib/args.mjs';
import { STATE_DIR } from '../lib/paths.mjs';

const stateDir = flag('state-dir') ?? STATE_DIR;
const pending = readPendingNotifications(stateDir);

if (pending.length === 0) {
  console.log('No pending task notifications.');
  process.exit(0);
}

console.log(`${pending.length} pending task notification(s):\n`);
for (const notification of pending) {
  console.log(`  [${notification.seq}] ${notification.type}`);
  console.log(`        Task:    ${notification.task_ref}`);
  console.log(`        Worker:  ${notification.agent_id}`);
  console.log(`        Result:  ${notification.success ? '✓ success' : '✗ failed'}`);
  if (notification.failure_reason) {
    console.log(`        Reason:  ${notification.failure_reason}`);
  }
  if (notification.exit_code !== undefined) {
    console.log(`        Exit:    ${notification.exit_code}`);
  }
  console.log(`        Time:    ${notification.finished_at}`);
  console.log('');
}
