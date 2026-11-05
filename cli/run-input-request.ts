#!/usr/bin/env node
import { flag, intFlag } from '../lib/args.ts';
import { DEFAULT_INPUT_REQUEST_TIMEOUT_MS } from '../lib/inputRequestConfig.ts';
import { executeRunInputRequest } from '../lib/runCommands.ts';
import { cliError } from './shared.ts';
import { USAGE } from './usage.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');
const question = flag('question');
const timeoutMs = intFlag('timeout-ms', DEFAULT_INPUT_REQUEST_TIMEOUT_MS);
const pollMs = intFlag('poll-ms', 1000);

if (!runId || !agentId || !question) {
  console.error(`Usage: ${USAGE['run-input-request']}`);
  process.exit(1);
}

try {
  process.exit(await executeRunInputRequest(runId, agentId, question, timeoutMs, pollMs));
} catch (error) {
  cliError(error);
}
