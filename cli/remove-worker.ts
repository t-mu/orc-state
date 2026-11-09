#!/usr/bin/env node
/**
 * cli/remove-worker.ts
 * Usage: node cli/remove-worker.ts <worker_id> [--keep-session] [--json]
 *
 * Stops a worker's session (unless --keep-session) and removes its
 * registration. Refuses while the worker holds an active claim.
 */
import { getAgent, removeAgent } from '../lib/agentRegistry.ts';
import { readClaims } from '../lib/stateReader.ts';
import { createAdapter } from '../adapters/index.ts';
import { assertProjectMode, STATE_DIR } from '../lib/paths.ts';
import { parseCommandArgsOrExit } from '../lib/args.ts';
import { exitWithJsonError, failCommand, formatErrorMessage, printJson } from './shared.ts';
import { USAGE } from './usage.ts';

const { values, positionals } = parseCommandArgsOrExit(USAGE['worker-remove'], { 'keep-session': { type: 'boolean' }, json: { type: 'boolean' } }, process.argv.slice(2), 1);
const workerId = positionals[0];
const keepSession = values['keep-session'] === true;
const json = values.json === true;

/** Refuse: a `--json` error object, or the message on stderr; exit 1 either way. */
async function refuse(code: string, message: string): Promise<never> {
  if (json) return exitWithJsonError(code, message);
  console.error(message);
  process.exit(1);
}

if (!workerId) {
  console.error(`Usage: ${USAGE['worker-remove']}`);
  process.exit(1);
}
try {
  assertProjectMode();
} catch (error) {
  await failCommand(error, json);
}

const worker = getAgent(STATE_DIR, workerId) ?? await refuse('not_found', `Worker not found: ${workerId}`);

// The master is replaced with orc start-session; a scout is the master's, removed with remove_scout.
if (worker.role === 'master' || worker.role === 'scout') {
  await refuse('conflict', `Cannot remove ${workerId}: it is the ${worker.role}, not a worker${worker.role === 'scout' ? ' (the master removes scouts with remove_scout)' : ''}`);
}

const activeClaim = (readClaims(STATE_DIR).claims ?? []).find((claim) =>
  claim.agent_id === workerId && ['claimed', 'in_progress'].includes(claim.state),
);
if (activeClaim) {
  await refuse('conflict', `Cannot remove ${workerId}: active claim exists (run_id=${activeClaim.run_id}, state=${activeClaim.state}); cancel or reset its task first`);
}

let sessionStopped = false;
if (worker.session_handle && !keepSession) {
  try {
    const adapter = createAdapter(worker.provider);
    await adapter.stop(worker.session_handle);
    sessionStopped = true;
  } catch (error) {
    console.error(`Warning: failed stopping session for ${workerId}: ${formatErrorMessage(error)}`);
  }
}

removeAgent(STATE_DIR, workerId);
if (json) printJson({ worker_id: workerId, removed: true, session_stopped: sessionStopped });
else console.log(`Removed worker ${workerId}`);
