#!/usr/bin/env node
import { flag } from '../lib/args.ts';
import { executeRunStart } from '../lib/runCommands.ts';
import { cliError } from './shared.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');

if (!runId || !agentId) {
  console.error('Usage: orc run-start --run-id=<id> --agent-id=<id>');
  process.exit(1);
}

try {
  executeRunStart(runId, agentId);
} catch (error) {
  cliError(error);
}
