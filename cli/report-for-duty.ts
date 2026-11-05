#!/usr/bin/env node
import { flag } from '../lib/args.ts';
import { submitLifecycle } from '../lib/lifecycleDispatch.ts';
import { cliError } from './shared.ts';
import { USAGE } from './usage.ts';

const agentId = flag('agent-id');
// The launched session's id; --session-token is its older name.
const sessionId = flag('session-id') ?? flag('session-token');

if (!agentId || !sessionId) {
  console.error(`Usage: ${USAGE['report-for-duty']}`);
  process.exit(1);
}

try {
  console.log((await submitLifecycle({ op: 'report-for-duty', agent_id: agentId, session_token: sessionId })).message);
} catch (error) {
  cliError(error);
}
