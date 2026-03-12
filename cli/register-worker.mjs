#!/usr/bin/env node
/**
 * cli/register-worker.mjs
 * Usage:
 *   node cli/register-worker.mjs <worker_id> --provider=<codex|claude|gemini> [--dispatch-mode=<mode>] [--role=<worker|reviewer>] [--capabilities=a,b]
 *
 * Advanced/debug path for manually creating a worker record.
 * Missing flags trigger interactive prompts when running in a TTY.
 */
import { registerAgent } from '../lib/agentRegistry.mjs';
import { PROVIDERS } from '../lib/providers.mjs';
import { STATE_DIR } from '../lib/paths.mjs';
import { flag } from '../lib/args.mjs';
import { promptAgentId, promptProvider, promptWorkerRole, promptCapabilities } from '../lib/prompts.mjs';

const argv = process.argv.slice(2);
const args = argv.filter((a) => a.startsWith('--'));
let workerId = argv.find((a) => !a.startsWith('--')) ?? null;

console.log('orc-worker-register (debug worker registration)');

workerId = await promptAgentId(workerId);
if (!workerId) {
  console.error('Missing agent ID. Usage: orc-worker-register <id> --provider=<codex|claude|gemini>');
  process.exit(1);
}
if (workerId === 'master') {
  console.error("Worker registration cannot use agent id 'master'. Use 'orc-start-session' for the master session.");
  process.exit(1);
}

let provider = await promptProvider(flag('provider', args), {
  message: 'Select provider for DEBUG worker registration',
});
if (!provider) {
  console.error('Missing required flag: --provider=<codex|claude|gemini>');
  process.exit(1);
}
if (!PROVIDERS.includes(provider)) {
  console.error(`Unsupported provider: ${provider}. Use one of: ${PROVIDERS.join(', ')}`);
  process.exit(1);
}

const role = (await promptWorkerRole(flag('role', args) ?? null)) ?? 'worker';
if (role === 'master') {
  console.error("Worker registration cannot use role=master. Use 'orc-start-session' to create or replace the master session.");
  process.exit(1);
}

const dispatchMode = flag('dispatch-mode', args);

const VALID_DISPATCH_MODES = ['autonomous', 'supervised', 'human-commanded'];
if (dispatchMode !== null && !VALID_DISPATCH_MODES.includes(dispatchMode)) {
  console.error(`Invalid dispatch-mode: ${dispatchMode}. Must be one of: ${VALID_DISPATCH_MODES.join(', ')}`);
  process.exit(1);
}

const capabilitiesRaw = flag('capabilities', args) ?? null;
const capabilitiesStr = await promptCapabilities(capabilitiesRaw);
const capabilities = capabilitiesStr
  ? capabilitiesStr.split(',').map((v) => v.trim()).filter(Boolean)
  : [];

try {
  const entry = registerAgent(STATE_DIR, {
    agent_id: workerId,
    provider,
    dispatch_mode: dispatchMode,
    role,
    capabilities,
  });
  console.log(`Registered ${entry.agent_id} (${entry.provider}) role=${entry.role}`);
  console.log('This command is for debug/recovery workflows. Normal startup uses orc-start-session and coordinator-managed workers.');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
