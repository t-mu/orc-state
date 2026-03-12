#!/usr/bin/env node
/**
 * cli/attach.ts
 * Usage: node cli/attach.ts <agent_id>
 *
 * Resolve agent_id -> session_handle from agents.json, then print the tail
 * of the agent's background PTY output log via adapter.attach().
 */
import { join } from 'node:path';
import { getAgent } from '../lib/agentRegistry.ts';
import { createAdapter } from '../adapters/index.ts';
import { STATE_DIR } from '../lib/paths.ts';

const agentId = process.argv[2];

if (!agentId) {
  console.error('Usage: orc-attach <agent_id>');
  process.exit(1);
}

const agent = getAgent(STATE_DIR, agentId);

if (!agent) {
  console.error(`Agent not found: ${agentId}`);
  console.error('Run: orc-status  to list registered agents.');
  process.exit(1);
}

if (!agent.session_handle) {
  console.error(`Agent ${agentId} has no active session (status: ${agent.status})`);
  console.error(`Run: orc-worker-start-session ${agentId}  to request a headless worker session.`);
  process.exit(1);
}

const adapter = createAdapter(agent.provider);
console.error(`Reading output log for ${agentId} ...`);
const alive = await adapter.heartbeatProbe(agent.session_handle);
if (!alive) {
  console.error(`Session ${agent.session_handle} is not reachable.`);
  process.exit(1);
}
adapter.attach(agent.session_handle);
const logPath = join(STATE_DIR, 'pty-logs', `${agentId}.log`);
console.error(`Log file: ${logPath}`);
