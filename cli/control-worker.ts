#!/usr/bin/env node
/**
 * cli/control-worker.ts
 * Usage: node cli/control-worker.ts <worker_id>
 *
 * Advanced/debug path that attaches to a live headless worker PTY session.
 */
import { join } from 'node:path';
import { getAgent, listAgents } from '../lib/agentRegistry.ts';
import { createAdapter } from '../adapters/index.ts';
import { STATE_DIR } from '../lib/paths.ts';

function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function chooseWorkerId(existingId: string | undefined) {
  if (existingId) return existingId;
  const workers = listAgents(STATE_DIR).filter((agent) => agent.role !== 'master');
  if (!workers.length) return null;
  if (!isInteractive()) return null;
  const { select } = await import('@inquirer/prompts');
  return select({
    message: 'Select worker',
    choices: workers.map((worker) => ({
      value: worker.agent_id,
      name: `${worker.agent_id} (${worker.provider})`,
      description: `status=${worker.status}`,
    })),
  });
}

const workerId = await chooseWorkerId(process.argv[2]);
if (!workerId) {
  console.error('Usage: orc control-worker <worker_id>');
  console.error('Debug command: use orc status to list workers and statuses.');
  process.exit(1);
}

const worker = getAgent(STATE_DIR, workerId);
if (!worker) {
  console.error(`Worker not found: ${workerId}`);
  console.error('Run: orc status  to list registered agents.');
  process.exit(1);
}
if (worker.role === 'master') {
  console.error(`Agent ${workerId} is role=master and cannot be controlled as a worker.`);
  process.exit(1);
}
if (!worker.session_handle) {
  console.error(`Worker ${workerId} has no active session (status: ${worker.status})`);
  console.error(`Worker sessions are task-scoped and exist only while a task is running.`);
  console.error(`Use "orc status" to see currently live worker sessions.`);
  process.exit(1);
}

const adapter = createAdapter(worker.provider);
const alive = await adapter.heartbeatProbe(worker.session_handle);
if (!alive) {
  console.error(`Worker session ${worker.session_handle} is not reachable.`);
  console.error(`The task-scoped session may have ended. Check "orc status" for currently live workers.`);
  process.exit(1);
}

console.error(`Attaching to worker ${workerId} (debug) ...`);
adapter.attach(worker.session_handle);
const logPath = join(STATE_DIR, 'pty-logs', `${workerId}.log`);
console.error(`Log file: ${logPath}`);
