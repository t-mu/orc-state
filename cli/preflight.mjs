#!/usr/bin/env node
/**
 * cli/preflight.mjs
 * Usage: node cli/preflight.mjs [--json]
 */
import { validateStateDir } from '../lib/stateValidation.mjs';
import { STATE_DIR } from '../lib/paths.mjs';
import { flag } from '../lib/args.mjs';
import { readAgents as readAgentsFromLib, readClaims as readClaimsFromLib } from '../lib/stateReader.mjs';
import { isBinaryAvailable, PROVIDER_BINARIES, PROVIDER_PACKAGES } from '../lib/binaryCheck.mjs';

const asJson = process.argv.includes('--json') || (flag('json') ?? '') === 'true';

const stateErrors = validateStateDir(STATE_DIR);
const agents = readAgentsFromLib(STATE_DIR).agents ?? [];
const claims = readClaimsFromLib(STATE_DIR).claims ?? [];

const checks = {
  state_valid: stateErrors.length === 0,
  has_registered_workers: agents.length > 0,
  has_online_workers: agents.some((a) => a.status !== 'offline'),
  orphaned_active_claims: getOrphanedClaims(agents, claims),
};
const providerBinaries = getProviderBinaries(agents);
const allBinariesPresent = Object.values(providerBinaries).every(Boolean);

const ok = checks.state_valid
  && checks.has_registered_workers
  && checks.orphaned_active_claims.length === 0
  && allBinariesPresent;

const result = {
  ok,
  checks: {
    ...checks,
    provider_binaries: providerBinaries,
    orphaned_active_claims_count: checks.orphaned_active_claims.length,
  },
  warnings: [
    ...(checks.has_registered_workers && !checks.has_online_workers
      ? ['All registered workers are offline. Start or rebind at least one worker session before coordinator run.']
      : []),
  ],
  details: {
    state_errors: stateErrors,
    orphaned_active_claims: checks.orphaned_active_claims,
  },
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(ok ? 0 : 1);
}

console.log('Orchestrator Preflight');
console.log('----------------------');
console.log(`state_valid:            ${checks.state_valid}`);
console.log(`has_registered_workers: ${checks.has_registered_workers}`);
console.log(`has_online_workers:     ${checks.has_online_workers}`);
console.log(`orphaned_active_claims: ${checks.orphaned_active_claims.length}`);
console.log('provider_binaries:');
for (const [provider, available] of Object.entries(providerBinaries)) {
  const packageName = PROVIDER_PACKAGES[provider] ?? '';
  if (available) {
    console.log(`  ${provider}: available`);
  } else if (packageName) {
    console.log(`  ${provider}: missing (install: npm install -g ${packageName})`);
  } else {
    console.log(`  ${provider}: missing`);
  }
}

if (stateErrors.length > 0) {
  console.log('');
  console.log('state_errors:');
  for (const e of stateErrors) console.log(`  - ${e}`);
}

if (checks.orphaned_active_claims.length > 0) {
  console.log('');
  console.log('orphaned_active_claims:');
  for (const c of checks.orphaned_active_claims) {
    console.log(`  - run=${c.run_id} task=${c.task_ref} agent=${c.agent_id} owner_status=${c.owner_status}`);
  }
}

if (result.warnings.length > 0) {
  console.log('');
  console.log('warnings:');
  for (const w of result.warnings) console.log(`  - ${w}`);
}

if (!ok) {
  console.log('');
  console.log('Suggested actions:');
  console.log('  1. orc-doctor  (check provider binaries and worker state)');
  console.log('  2. orc-worker-clearall  (remove stale workers)');
  process.exit(1);
}

console.log('');
console.log('Preflight passed.');

function getOrphanedClaims(agents, claims) {
  const out = [];
  for (const claim of claims) {
    if (!['claimed', 'in_progress'].includes(claim.state)) continue;
    const owner = agents.find((a) => a.agent_id === claim.agent_id);
    if (!owner || owner.status === 'offline') {
      out.push({
        run_id: claim.run_id,
        task_ref: claim.task_ref,
        agent_id: claim.agent_id,
        owner_status: owner?.status ?? 'missing',
      });
    }
  }
  return out;
}

function getProviderBinaries(agents) {
  const providers = [...new Set(agents.map((a) => a.provider).filter(Boolean))];
  return Object.fromEntries(
    providers.map((provider) => {
      const binary = PROVIDER_BINARIES[provider] ?? provider;
      return [provider, isBinaryAvailable(binary)];
    }),
  );
}
