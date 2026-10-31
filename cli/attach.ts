#!/usr/bin/env node
/**
 * cli/attach.ts
 * Usage: orc attach <agent_id|run_id> [--write]
 *
 * Open a real tmux client on a worker's session in orc's private tmux server.
 * Observe by default (`attach-session -r`: keystrokes do not reach the worker,
 * Ctrl-b d detaches); `--write` attaches with input enabled.
 */
import { spawnSync } from 'node:child_process';
import { getAgent } from '../lib/agentRegistry.ts';
import { boolFlag } from '../lib/args.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { readClaims } from '../lib/stateReader.ts';
import { readProjectDescriptor } from '../lib/projectContext.ts';
import { formatProjectIdentity } from '../lib/projectHealth.ts';
import { tmuxAttachCommand } from '../adapters/tmux.ts';
import type { Claim } from '../types/claims.ts';

const id = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const write = boolFlag('write');

if (!id) {
  console.error('Usage: orc attach <agent_id|run_id> [--write]');
  process.exit(1);
}

let claims: Claim[] = [];
try { claims = readClaims(STATE_DIR).claims; } catch { /* no run store: agent ids still resolve */ }
// Worker names are unique only among active workers, so only an active claim names the run's current agent.
const isActive = (claim: Claim) => claim.state === 'claimed' || claim.state === 'in_progress';

// An agent id wins; otherwise the argument is a run id and resolves to the claim's agent.
let agent = getAgent(STATE_DIR, id);
let runId: string | null = null;
if (agent) {
  runId = claims.find((claim) => claim.agent_id === id && isActive(claim))?.run_id ?? null;
} else {
  const claim = claims.find((entry) => entry.run_id === id);
  if (claim && !isActive(claim)) {
    console.error(`Run ${id} is not active (state: ${claim.state}).`);
    process.exit(1);
  }
  if (claim) {
    runId = claim.run_id;
    agent = getAgent(STATE_DIR, claim.agent_id);
    if (!agent) {
      console.error(`Run ${id} belongs to agent ${claim.agent_id}, which is no longer registered.`);
      process.exit(1);
    }
  }
}

if (!agent) {
  console.error(`No agent or run found: ${id}`);
  console.error('Run: orc status  to list registered agents and active runs.');
  process.exit(1);
}

const agentId = agent.agent_id;
const handle = agent.session_handle;
if (!handle) {
  console.error(`Agent ${agentId} has no active session (status: ${agent.status})`);
  console.error(`Worker sessions are task-scoped and are created automatically when a task is dispatched.`);
  console.error(`Use "orc status" to see currently live worker sessions.`);
  process.exit(1);
}

const runArg = runId ?? '<run_id>';
if (!handle.startsWith('tmux:')) {
  console.error(`Agent ${agentId} runs a ${handle.split(':')[0]}: session, which has no tmux terminal to attach to.`);
  console.error(`Use: orc terminal provider ${runArg} [--write]`);
  process.exit(1);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('orc attach needs an interactive terminal on stdin and stdout.');
  console.error(`Run orc attach from a real terminal, or print a snapshot with: orc terminal provider ${runArg} --once`);
  process.exit(1);
}

console.error(formatProjectIdentity(readProjectDescriptor(STATE_DIR)));
console.error(`Attaching to ${agentId} (${runId ?? 'no active run'}) ${write ? 'with write access' : 'read-only'} — Ctrl-b d to detach`);

// tmux refuses to attach from inside another tmux client while TMUX is set.
// orc's server is a different socket, so switch-client cannot reach it; a
// nested client is the only option.
const { TMUX: _tmux, ...env } = process.env;
const { command, args } = tmuxAttachCommand(handle.slice('tmux:'.length), { write, providerRef: agent.provider_ref });
const result = spawnSync(command, args, { stdio: 'inherit', env });
if (result.error) {
  console.error(`Could not run ${command}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
