#!/usr/bin/env node
/**
 * cli/progress.ts
 * Usage:
 *   node cli/progress.ts --event=<type> --run-id=<id> --agent-id=<id> [--phase=<name>] [--reason=<text>] [--policy=<requeue|block>]
 */
import { flag } from '../lib/args.ts';
import { submitLifecycle } from '../lib/lifecycleDispatch.ts';
import { cliError } from './shared.ts';

const event = flag('event');
const runId = flag('run-id');
const agentId = flag('agent-id');
const phase = flag('phase');
const reason = flag('reason');
const policy = flag('policy') ?? 'requeue';

if (!event || !runId || !agentId) {
  console.error('Usage: orc progress --event=<type> --run-id=<id> --agent-id=<id> [--phase=<name>] [--reason=<text>] [--policy=<requeue|block>]');
  process.exit(1);
}

try {
  console.log((await submitLifecycle({ op: 'progress', run_id: runId, agent_id: agentId, event, phase, reason, policy })).message);
} catch (error) {
  cliError(error);
}
