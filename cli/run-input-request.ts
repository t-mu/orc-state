#!/usr/bin/env node
import { flag, intFlag } from '../lib/args.ts';
import { DEFAULT_INPUT_REQUEST_TIMEOUT_MS } from '../lib/inputRequestConfig.ts';
import { executeRunInputRequest } from '../lib/runCommands.ts';
import { cliError } from './shared.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');
const question = flag('question');
const timeoutMs = intFlag('timeout-ms', DEFAULT_INPUT_REQUEST_TIMEOUT_MS);
const pollMs = intFlag('poll-ms', 1000);

if (!runId || !agentId || !question) {
  console.error('Usage: orc-run-input-request --run-id=<id> --agent-id=<id> --question=<text> [--timeout-ms=<ms>] [--poll-ms=<ms>]');
  process.exit(1);
}

try {
  await executeRunInputRequest(runId, agentId, question, timeoutMs, pollMs);
} catch (error) {
  cliError(error);
}
