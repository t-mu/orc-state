#!/usr/bin/env node
import { flag } from '../lib/args.ts';
import { executeRunStart } from '../lib/runCommands.ts';
import { cliError } from './shared.ts';
import { USAGE } from './usage.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');

if (!runId || !agentId) {
  console.error(`Usage: ${USAGE['run-start']}`);
  process.exit(1);
}

try {
  await executeRunStart(runId, agentId);
} catch (error) {
  cliError(error);
}
