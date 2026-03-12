#!/usr/bin/env node
/**
 * cli/doctor.mjs
 * Usage: node cli/doctor.mjs [--json]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../lib/paths.mjs';
import { flag, intFlag } from '../lib/args.mjs';
import { isBinaryAvailable, PROVIDER_BINARIES, PROVIDER_PACKAGES } from '../lib/binaryCheck.mjs';

const asJson = process.argv.includes('--json') || (flag('json') ?? '') === 'true';
const staleStartThresholdMs = intFlag('stale-start-ms', 5 * 60 * 1000);
const staleProgressThresholdMs = intFlag('stale-progress-ms', 20 * 60 * 1000);
const nowMs = Date.now();

const agents = readAgents();
const claims = readClaims();
const providers = new Set(agents.map((a) => a.provider));

const checks = {
  providerBinaries: {},
  staleLinkedWorkers: [],
  orphanedActiveClaims: [],
  staleActiveClaims: [],
};

for (const provider of providers) {
  if (!provider) continue;
  checks.providerBinaries[provider] = checkProviderBinary(provider);
}

for (const agent of agents) {
  if (agent.session_handle && agent.status === 'offline') {
    checks.staleLinkedWorkers.push({
      agent_id: agent.agent_id,
      status: agent.status,
      session_handle: agent.session_handle,
      note: 'offline worker still has session_handle',
    });
  }
}

for (const claim of claims) {
  if (!['claimed', 'in_progress'].includes(claim.state)) continue;
  const owner = agents.find((a) => a.agent_id === claim.agent_id) ?? null;
  if (!owner || owner.status === 'offline') {
    checks.orphanedActiveClaims.push({
      run_id: claim.run_id,
      task_ref: claim.task_ref,
      agent_id: claim.agent_id,
      claim_state: claim.state,
      owner_status: owner?.status ?? 'missing',
    });
  }

  const anchor = claim.state === 'claimed'
    ? claim.claimed_at
    : (claim.last_heartbeat_at ?? claim.started_at ?? claim.claimed_at);
  const idleMs = anchor ? nowMs - new Date(anchor).getTime() : NaN;
  if (Number.isNaN(idleMs)) continue;
  if (claim.input_state === 'awaiting_input') continue;

  const isStale = claim.state === 'claimed'
    ? idleMs >= staleStartThresholdMs
    : idleMs >= staleProgressThresholdMs;
  if (!isStale) continue;
  checks.staleActiveClaims.push({
    run_id: claim.run_id,
    task_ref: claim.task_ref,
    agent_id: claim.agent_id,
    claim_state: claim.state,
    idle_seconds: Math.round(idleMs / 1000),
    threshold_seconds: Math.round((claim.state === 'claimed' ? staleStartThresholdMs : staleProgressThresholdMs) / 1000),
    hint: claim.state === 'claimed'
      ? `Worker ${claim.agent_id} has not acknowledged run_started for ${Math.round(idleMs / 1000)}s. Check coordinator logs.`
      : `Worker ${claim.agent_id} has not emitted progress for ${Math.round(idleMs / 1000)}s. Check coordinator logs.`,
  });
}

const summary = {
  ok:
    Object.values(checks.providerBinaries).every((c) => c.ok) &&
    checks.staleLinkedWorkers.length === 0 &&
    checks.orphanedActiveClaims.length === 0 &&
    checks.staleActiveClaims.length === 0,
  registered_workers: agents.length,
  active_claims: claims.filter((c) => ['claimed', 'in_progress'].includes(c.state)).length,
  checks,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
}

console.log('Orchestrator Doctor');
console.log('-------------------');
console.log(`registered_workers: ${summary.registered_workers}`);
console.log(`active_claims: ${summary.active_claims}`);
console.log('');

console.log('provider binaries available');
if (Object.keys(checks.providerBinaries).length === 0) {
  console.log('  (no registered providers)');
} else {
  for (const [provider, result] of Object.entries(checks.providerBinaries)) {
    console.log(`  ${provider}: ok=${result.ok} binary=${result.binary}`);
    if (!result.ok && result.detail) console.log(`    detail: ${result.detail}`);
  }
}

console.log('');
console.log(`stale linked workers: ${checks.staleLinkedWorkers.length}`);
for (const w of checks.staleLinkedWorkers) {
  console.log(`  ${w.agent_id} ${w.status} ${w.session_handle}`);
}

console.log('');
console.log(`orphaned active claims: ${checks.orphanedActiveClaims.length}`);
for (const c of checks.orphanedActiveClaims) {
  console.log(`  ${c.run_id} task=${c.task_ref} agent=${c.agent_id} owner_status=${c.owner_status}`);
}

console.log('');
console.log(`stale active claims: ${checks.staleActiveClaims.length}`);
for (const c of checks.staleActiveClaims) {
  console.log(`  ${c.run_id} task=${c.task_ref} state=${c.claim_state} idle=${c.idle_seconds}s threshold=${c.threshold_seconds}s`);
  console.log(`    hint: ${c.hint}`);
}

if (!summary.ok) {
  console.log('');
  console.log('Suggested fixes:');
  console.log('  1. Install missing provider binaries (npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli)');
  console.log('  2. orc-worker-clearall');
  console.log('  3. orc-runs-active --json');
  console.log('  4. orc-status --json');
  process.exit(1);
}

console.log('');
console.log('All checks passed.');

function readAgents() {
  try {
    const json = JSON.parse(readFileSync(join(STATE_DIR, 'agents.json'), 'utf8'));
    return json.agents ?? [];
  } catch {
    return [];
  }
}

function readClaims() {
  try {
    const json = JSON.parse(readFileSync(join(STATE_DIR, 'claims.json'), 'utf8'));
    return json.claims ?? [];
  } catch {
    return [];
  }
}

function checkProviderBinary(provider) {
  const binary = PROVIDER_BINARIES[provider] ?? provider;
  const packageName = PROVIDER_PACKAGES[provider];
  const ok = isBinaryAvailable(binary);
  const installHint = packageName ? `npm install -g ${packageName}` : null;
  return {
    ok,
    binary,
    package: packageName ?? null,
    detail: ok ? '' : (installHint ? `Run: ${installHint}` : `Binary '${binary}' not found on PATH`),
  };
}
