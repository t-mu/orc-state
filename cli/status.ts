#!/usr/bin/env node
/**
 * cli/status.ts
 * Usage: node cli/status.ts [--json] [--mine --agent-id=<id>]
 *
 * Print current orchestrator state from base files + events.jsonl.
 */
import { flag } from '../lib/args.ts';
import { buildAgentStatus, buildStatus, formatAgentStatus, formatStatus } from '../lib/statusView.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { validateStateDir } from '../lib/stateValidation.ts';

const json = process.argv.includes('--json');
const mine = process.argv.includes('--mine');
const agentId = flag('agent-id');

if (mine && !agentId) {
  console.error('Usage: orc-status --mine --agent-id=<id> [--json]');
  process.exit(1);
}

const errors = validateStateDir(STATE_DIR);
if (errors.length > 0) {
  console.error('State validation failed:');
  for (const e of errors) console.error(' ', e);
  process.exit(1);
}

if (mine) {
  const agentStatus = buildAgentStatus(STATE_DIR, agentId as string);
  if (!(agentStatus as Record<string, unknown>).agent) {
    console.error(`Agent not found: ${agentId}`);
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(agentStatus, null, 2));
  } else {
    console.log(formatAgentStatus(agentStatus, agentId as string));
  }
  process.exit(0);
}

const status = buildStatus(STATE_DIR);

if (json) {
  console.log(JSON.stringify(status, null, 2));
} else {
  console.log(formatStatus(status));
}
