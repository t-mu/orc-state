#!/usr/bin/env node
/**
 * cli/start-worker-session.ts
 * Usage:
 *   node cli/start-worker-session.ts <worker_id> --provider=<codex|claude|gemini> [--role=<worker|reviewer|scout>] [--force-rebind]
 *
 * Advanced/debug path for manually asking the coordinator to provision or
 * rebind a headless worker session.
 *
 * Missing flags trigger interactive prompts when running in a TTY.
 */
import { getAgent, registerAgent, updateAgentRuntime } from '../lib/agentRegistry.ts';
import { createAdapter } from '../adapters/index.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { boolFlag, flag } from '../lib/args.ts';
import { promptAgentId, promptProvider, promptWorkerRole } from '../lib/prompts.ts';
import { checkAndInstallBinary } from '../lib/binaryCheck.ts';

const argv = process.argv.slice(2);
let workerId: string | null = argv.find((a) => !a.startsWith('--')) ?? null;

console.log('orc-worker-start-session (debug worker session control)');

workerId = await promptAgentId(workerId);
if (!workerId) {
  console.error('Usage: orc-worker-start-session <worker_id> --provider=<codex|claude|gemini> [--role=<worker|reviewer|scout>] [--force-rebind]');
  process.exit(1);
}
if (workerId === 'master') {
  console.error("Worker session provisioning cannot use agent id 'master'. Use 'orc-start-session' for the master session.");
  process.exit(1);
}

const provider = flag('provider');
const roleFlag = flag('role');
const forceRebind = boolFlag('force-rebind');

let worker = getAgent(STATE_DIR, workerId);
if (worker?.role === 'master') {
  console.error(`Agent '${workerId}' is the registered master. Use 'orc-start-session' to manage the master session.`);
  process.exit(1);
}

if (worker && provider && provider !== worker.provider) {
  console.error(`Provider mismatch for ${workerId}: registered=${worker.provider}, requested=${provider}`);
  process.exit(1);
}

const resolvedProvider = worker?.provider ?? await promptProvider(provider, {
  message: 'Select provider for DEBUG worker session provisioning',
});
if (!resolvedProvider) {
  console.error('Worker not found and no provider given. Use --provider=<codex|claude|gemini>.');
  process.exit(1);
}

const binaryOk = await checkAndInstallBinary(resolvedProvider);
if (!binaryOk) {
  console.error(`Cannot start worker session: '${resolvedProvider}' binary not available.`);
  process.exit(1);
}

if (!worker) {
  const resolvedRole = (await promptWorkerRole(roleFlag ?? null)) ?? 'worker';
  if (resolvedRole === 'master') {
    console.error("Worker session provisioning cannot use role=master. Use 'orc-start-session' to create or replace the master session.");
    process.exit(1);
  }
  registerAgent(STATE_DIR, {
    agent_id: workerId,
    provider: resolvedProvider,
    role: resolvedRole as import('../types/agents.ts').AgentRole,
  });
  worker = getAgent(STATE_DIR, workerId);
  console.log(`Registered ${workerId}`);
}

if (!worker) {
  console.error(`Failed to load agent record for ${workerId} after registration.`);
  process.exit(1);
}

const adapter = createAdapter(worker.provider);

if (worker.session_handle) {
  const alive = await adapter.heartbeatProbe(worker.session_handle);
  if (alive && forceRebind) {
    await adapter.stop(worker.session_handle);
    updateAgentRuntime(STATE_DIR, worker.agent_id, {
      status: 'offline',
      session_handle: null,
      provider_ref: null,
      last_status_change_at: new Date().toISOString(),
    });
    worker.session_handle = null;
  } else if (!alive) {
    updateAgentRuntime(STATE_DIR, worker.agent_id, {
      status: 'offline',
      session_handle: null,
      provider_ref: null,
      last_status_change_at: new Date().toISOString(),
    });
    worker.session_handle = null;
  } else {
    // Session is alive and no rebind requested — normalize registry status in case
    // the entry was left as 'offline' by a prior coordinator crash or manual edit.
    updateAgentRuntime(STATE_DIR, worker.agent_id, {
      status: 'running',
      last_heartbeat_at: new Date().toISOString(),
    });
  }
}

if (!worker.session_handle) {
  console.log(`Agent '${worker.agent_id}' registered (${worker.provider}). Coordinator will provision the headless session on its next tick, even while idle.`);
  console.log('This command is for debug/recovery workflows. Normal task execution launches workers per task automatically.');
  console.log(`Use: orc-watch     — monitor for the agent_online event / running status`);
  console.log(`Use: orc-attach ${worker.agent_id}  — attach to worker output once running`);
} else {
  console.log(`Headless session ready: ${worker.session_handle}`);
  console.log('This command is for debug/recovery workflows. Normal task execution launches workers per task automatically.');
  console.log(`Use: orc-attach ${worker.agent_id}  — attach to worker output`);
}
