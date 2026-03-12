#!/usr/bin/env node
/**
 * cli/deregister.mjs
 * Usage: node cli/deregister.mjs <agent_id>
 */
import { removeAgent, getAgent } from '../lib/agentRegistry.mjs';
import { readClaims } from '../lib/stateReader.mjs';
import { STATE_DIR } from '../lib/paths.mjs';

const agentId = process.argv[2];

if (!agentId) {
  console.error('Usage: orc-deregister <agent_id>');
  process.exit(1);
}

const agent = getAgent(STATE_DIR, agentId);
if (!agent) {
  console.error(`Agent not found: ${agentId}`);
  process.exit(1);
}

const claims = readClaims(STATE_DIR).claims ?? [];
const activeClaim = claims.find((claim) =>
  claim.agent_id === agentId && ['claimed', 'in_progress'].includes(claim.state),
);

if (activeClaim) {
  console.error(
    `Cannot deregister ${agentId}: active claim exists (run_id=${activeClaim.run_id}, state=${activeClaim.state})`,
  );
  process.exit(1);
}

removeAgent(STATE_DIR, agentId);
console.log(`Deregistered agent ${agentId}`);
