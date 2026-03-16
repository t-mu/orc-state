#!/usr/bin/env node
/**
 * cli/worker-status.ts
 * Usage: orc worker-status [<agent_id>] [--json]
 *
 * Show worker agent status. If agent_id provided, show single agent detail.
 */
import { STATE_DIR } from '../lib/paths.ts';
import { readAgents, readClaims } from '../lib/stateReader.ts';

const asJson = process.argv.includes('--json');
const agentId = process.argv.slice(2).find((a) => !a.startsWith('-'));

const agentsState = readAgents(STATE_DIR);
const claimsState = readClaims(STATE_DIR);

const now = Date.now();

// Build active task map by agent_id
const activeTaskByAgent = new Map<string, string>();
for (const c of claimsState.claims) {
  if (c.state === 'claimed' || c.state === 'in_progress') {
    if (!activeTaskByAgent.has(c.agent_id)) {
      activeTaskByAgent.set(c.agent_id, c.task_ref);
    }
  }
}

// Filter to non-master agents
const workers = agentsState.agents.filter((a) => a.role !== 'master');

if (agentId) {
  const agent = agentsState.agents.find((a) => a.agent_id === agentId);
  if (!agent) {
    console.error(`agent not found: ${agentId}`);
    process.exit(1);
  }

  const heartbeatSec = agent.last_heartbeat_at
    ? Math.round((now - new Date(agent.last_heartbeat_at).getTime()) / 1000)
    : null;

  if (asJson) {
    console.log(JSON.stringify({
      ...agent,
      active_task_ref: activeTaskByAgent.get(agentId) ?? null,
      heartbeat_seconds_ago: heartbeatSec,
    }, null, 2));
    process.exit(0);
  }

  console.log(`Agent: ${agent.agent_id}`);
  console.log(`  provider:   ${agent.provider}`);
  console.log(`  status:     ${agent.status}`);
  console.log(`  role:       ${agent.role ?? 'worker'}`);
  console.log(`  task:       ${activeTaskByAgent.get(agentId) ?? 'idle'}`);
  console.log(`  heartbeat:  ${heartbeatSec != null ? `${heartbeatSec}s ago` : 'never'}`);
  console.log(`  session:    ${agent.session_handle ?? 'none'}`);
  process.exit(0);
}

if (asJson) {
  const rows = workers.map((agent) => {
    const heartbeatSec = agent.last_heartbeat_at
      ? Math.round((now - new Date(agent.last_heartbeat_at).getTime()) / 1000)
      : null;
    return {
      ...agent,
      active_task_ref: activeTaskByAgent.get(agent.agent_id) ?? null,
      heartbeat_seconds_ago: heartbeatSec,
    };
  });
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

if (workers.length === 0) {
  console.log('(no workers registered)');
  process.exit(0);
}

const COL_AGENT = 14;
const COL_PROVIDER = 9;
const COL_STATUS = 8;
const COL_ROLE = 7;
const COL_TASK = 21;

console.log(
  'AGENT'.padEnd(COL_AGENT) +
  'PROVIDER'.padEnd(COL_PROVIDER) +
  'STATUS'.padEnd(COL_STATUS) +
  'ROLE'.padEnd(COL_ROLE) +
  'TASK'.padEnd(COL_TASK) +
  'HEARTBEAT',
);

for (const agent of workers) {
  const heartbeatSec = agent.last_heartbeat_at
    ? Math.round((now - new Date(agent.last_heartbeat_at).getTime()) / 1000)
    : null;
  const heartbeatStr = heartbeatSec != null ? `${heartbeatSec}s ago` : 'never';
  const taskRef = activeTaskByAgent.get(agent.agent_id) ?? '—';

  console.log(
    agent.agent_id.padEnd(COL_AGENT) +
    agent.provider.padEnd(COL_PROVIDER) +
    agent.status.padEnd(COL_STATUS) +
    (agent.role ?? 'worker').padEnd(COL_ROLE) +
    taskRef.padEnd(COL_TASK) +
    heartbeatStr,
  );
}
