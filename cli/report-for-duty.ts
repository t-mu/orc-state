#!/usr/bin/env node
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { getAgent, updateAgentRuntime } from '../lib/agentRegistry.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { flag } from '../lib/args.ts';

const agentId = flag('agent-id');
const sessionToken = flag('session-token');

if (!agentId || !sessionToken) {
  console.error('Usage: orc-report-for-duty --agent-id=<id> --session-token=<token>');
  process.exit(1);
}

try {
  const agent = getAgent(STATE_DIR, agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  if (agent.session_token !== sessionToken) {
    throw new Error(`Session token mismatch for ${agentId}`);
  }

  const at = new Date().toISOString();
  appendSequencedEvent(STATE_DIR, {
    ts: at,
    event: 'reported_for_duty',
    actor_type: 'agent',
    actor_id: agentId,
    agent_id: agentId,
    payload: {
      session_token: sessionToken,
    },
  }, { lockStrategy: 'none' });

  updateAgentRuntime(STATE_DIR, agentId, {
    session_ready_at: at,
    last_heartbeat_at: at,
  });

  console.log(`reported_for_duty: ${agentId}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}
