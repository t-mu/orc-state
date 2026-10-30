#!/usr/bin/env node
/**
 * cli/preflight.ts
 * Usage: node cli/preflight.ts [--json]
 */
import { execSync } from 'node:child_process';
import { validateStateDir } from '../lib/stateValidation.ts';
import { ACTIVE_PROJECT, LEGACY_SIBLING_TARGET, ORCHESTRATION_ROOT, STATE_DIR, TARGET_REPO_ROOT, WORKTREES_DIR } from '../lib/paths.ts';
import { checkProjectHealth, formatProjectIdentity } from '../lib/projectHealth.ts';
import { boolFlag } from '../lib/args.ts';
import { readAgents as readAgentsFromLib, readClaims as readClaimsFromLib } from '../lib/stateReader.ts';
import { isBinaryAvailable, PROVIDER_BINARIES, PROVIDER_PACKAGES } from '../lib/binaryCheck.ts';
import { getOrphanedClaims } from '../lib/claimDiagnostics.ts';
import type { Agent } from '../types/agents.ts';

const asJson = boolFlag('json');

const stateErrors = validateStateDir(STATE_DIR);
const gitRepo = isGitRepo(ACTIVE_PROJECT ? TARGET_REPO_ROOT : undefined);
const projectHealth = ACTIVE_PROJECT ? checkProjectHealth(ACTIVE_PROJECT, STATE_DIR, { worktreesDir: WORKTREES_DIR }) : null;
const agentsRaw = readAgentsFromLib(STATE_DIR).agents ?? [];
const claimsRaw = readClaimsFromLib(STATE_DIR).claims ?? [];
const agents = agentsRaw;
const claims = claimsRaw;

// A legacy installation (attached or sibling) fails preflight; it must be migrated before it runs.
const siblingRetired = LEGACY_SIBLING_TARGET !== null;
const legacyInstallation = !ACTIVE_PROJECT;

const checks = {
  state_valid: stateErrors.length === 0,
  has_registered_workers: agents.length > 0,
  has_online_workers: agents.some((a) => a.status !== 'offline'),
  orphaned_active_claims: getOrphanedClaims(agents, claims),
  legacy_layout_supported: !legacyInstallation,
  project_ok: projectHealth?.ok ?? true,
};
const providerBinaries = getProviderBinaries(agents);
const allBinariesPresent = Object.values(providerBinaries).every(Boolean);

const ok = checks.state_valid
  && checks.has_registered_workers
  && checks.orphaned_active_claims.length === 0
  && allBinariesPresent
  && !legacyInstallation
  && checks.project_ok;

const result = {
  ok,
  project: projectHealth?.project ?? null,
  checks: {
    ...checks,
    provider_binaries: providerBinaries,
    orphaned_active_claims_count: checks.orphaned_active_claims.length,
  },
  warnings: [
    ...(checks.has_registered_workers && !checks.has_online_workers
      ? ['All registered workers are offline. Start or rebind at least one worker session before coordinator run.']
      : []),
    ...(!gitRepo
      ? ['Not inside a git repository — worktree isolation will not work']
      : []),
    ...(siblingRetired
      ? [`sibling layout error (fails preflight): target_repo ${LEGACY_SIBLING_TARGET} is retired; run orc project migrate ${ORCHESTRATION_ROOT} --execute`]
      : []),
    ...(legacyInstallation && !siblingRetired ? [`legacy installation error (fails preflight): ${ORCHESTRATION_ROOT} no longer runs; migrate it with orc project migrate ${ORCHESTRATION_ROOT} --execute`] : []),
    ...(projectHealth?.errors ?? []).map((e) => `project error (fails preflight): ${e}`),
    ...(projectHealth?.warnings ?? []).map((w) => `project warning: ${w}`),
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
console.log(formatProjectIdentity(projectHealth?.project ?? null));
console.log(`state_valid:            ${checks.state_valid}`);
console.log(`has_registered_workers: ${checks.has_registered_workers}`);
console.log(`has_online_workers:     ${checks.has_online_workers}`);
console.log(`orphaned_active_claims: ${checks.orphaned_active_claims.length}`);
if (siblingRetired) console.log('sibling_layout:         retired (run orc project migrate)');
console.log('provider_binaries:');
for (const [provider, available] of Object.entries(providerBinaries)) {
  const packageName = (PROVIDER_PACKAGES)[provider] ?? '';
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
    console.log(`  - run=${String(c.run_id)} task=${String(c.task_ref)} agent=${String(c.agent_id)} owner_status=${String(c.owner_status)}`);
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
  console.log('  1. orc doctor  (check provider binaries and worker state)');
  console.log('  2. orc worker-gc  (remove stale workers)');
  process.exit(1);
}

console.log('');
console.log('Preflight passed.');


function isGitRepo(cwd?: string): boolean {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'pipe', ...(cwd ? { cwd } : {}) });
    return true;
  } catch {
    return false;
  }
}

function getProviderBinaries(agents: Agent[]) {
  const providers = [...new Set(agents.map((a) => a.provider).filter(Boolean))];
  return Object.fromEntries(
    providers.map((provider) => {
      const binary = (PROVIDER_BINARIES)[provider] ?? provider;
      return [provider, isBinaryAvailable(binary)];
    }),
  );
}
