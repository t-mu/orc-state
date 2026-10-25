#!/usr/bin/env node
import { flag } from '../lib/args.ts';
import { submitLifecycle } from '../lib/lifecycleDispatch.ts';
import { cliError } from './shared.ts';

const agentId = flag('agent-id');
const sessionToken = flag('session-token');

if (!agentId || !sessionToken) {
  console.error('Usage: orc report-for-duty --agent-id=<id> --session-token=<token>');
  process.exit(1);
}

try {
  console.log((await submitLifecycle({ op: 'report-for-duty', agent_id: agentId, session_token: sessionToken })).message);
} catch (error) {
  cliError(error);
}
