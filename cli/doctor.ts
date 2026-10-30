#!/usr/bin/env node
/**
 * cli/doctor.ts
 * Usage: node cli/doctor.ts [--json]
 */
import { execSync } from 'node:child_process';
import { ACTIVE_PROJECT, LEGACY_SIBLING_TARGET, ORCHESTRATION_ROOT, STATE_DIR, TARGET_REPO_ROOT, WORKTREES_DIR } from '../lib/paths.ts';
import { readMigrationMarker } from '../lib/projectContext.ts';
import { checkProjectHealth, formatProjectIdentity } from '../lib/projectHealth.ts';
import { boolFlag, intFlag } from '../lib/args.ts';
import { isBinaryAvailable, PROVIDER_BINARIES, PROVIDER_PACKAGES } from '../lib/binaryCheck.ts';
import { readAgents, readClaims } from '../lib/stateReader.ts';
import { validateStateDir, validateMemoryDb } from '../lib/stateValidation.ts';
import { detectLifecycleIssues, type LifecycleIssue } from '../lib/lifecycleDiagnostics.ts';
import { claimedRunStartupAnchor } from '../lib/runActivity.ts';
import { getOrphanedClaims } from '../lib/claimDiagnostics.ts';
import { checkSandboxControlSocket, checkSandboxDependencies } from '../lib/sandboxDeps.ts';
import { inspectRuntimeSchema } from '../lib/runtimeSchema.ts';
import type { Agent } from '../types/agents.ts';
import type { Claim } from '../types/claims.ts';

const asJson = boolFlag('json');
const staleStartThresholdMs = intFlag('stale-start-ms', 5 * 60 * 1000);
const staleProgressThresholdMs = intFlag('stale-progress-ms', 20 * 60 * 1000);
const nowMs = Date.now();

// A project's Git checks run against its registered target, wherever the command is invoked.
const gitRepo = isGitRepo(ACTIVE_PROJECT ? TARGET_REPO_ROOT : undefined);
const stateErrors = validateStateDir(STATE_DIR);
const projectHealth = ACTIVE_PROJECT ? checkProjectHealth(ACTIVE_PROJECT, STATE_DIR, { worktreesDir: WORKTREES_DIR }) : null;
const agents: Agent[] = safeRead(() => readAgents(STATE_DIR).agents, []);
const claims: Claim[] = safeRead(() => readClaims(STATE_DIR).claims, []);
const providers = new Set(agents.map((a) => a.provider));

const sandboxDeps = checkSandboxDependencies();
const sandboxControlSocket = checkSandboxControlSocket({ project: Boolean(ACTIVE_PROJECT) });
const memoryHealth = validateMemoryDb(STATE_DIR);
const runtimeSchema = inspectRuntimeSchema(STATE_DIR);
// Neither a legacy attached installation nor a sibling layout runs any more; both must be migrated.
const legacyLayout = ACTIVE_PROJECT ? null : {
  ok: false,
  root: ORCHESTRATION_ROOT,
  sibling_target: LEGACY_SIBLING_TARGET,
  message: LEGACY_SIBLING_TARGET
    ? `sibling layout (target_repo: ${LEGACY_SIBLING_TARGET}) is retired; run orc project migrate ${ORCHESTRATION_ROOT} --execute`
    : `legacy installation at ${ORCHESTRATION_ROOT} no longer runs; migrate it into a project with orc project migrate ${ORCHESTRATION_ROOT} --execute`,
};

// A legacy state directory that was migrated must not be run again; the project owns its state now.
const migratedTo = ACTIVE_PROJECT ? null : readMigrationMarker(STATE_DIR);

const checks: Record<string, unknown> = {
  project: projectHealth,
  migratedTo,
  gitRepo,
  providerBinaries: {} as Record<string, unknown>,
  staleLinkedWorkers: [] as unknown[],
  orphanedActiveClaims: [] as unknown[],
  staleActiveClaims: [] as unknown[],
  lifecycleIssues: [] as unknown[],
  stateErrors,
  sandboxDependencies: sandboxDeps,
  sandboxControlSocket,
  memoryHealth,
  runtimeSchema,
  legacyLayout,
};

for (const provider of providers) {
  if (!provider) continue;
  (checks.providerBinaries as Record<string, unknown>)[provider] = checkProviderBinary(provider);
}

for (const agent of agents) {
  if (agent.session_handle && agent.status === 'offline') {
    (checks.staleLinkedWorkers as unknown[]).push({
      agent_id: agent.agent_id,
      status: agent.status,
      session_handle: agent.session_handle,
      note: 'offline worker still has session_handle',
    });
  }
}

(checks.orphanedActiveClaims as unknown[]).push(...getOrphanedClaims(agents, claims));

for (const claim of claims) {
  if (!['claimed', 'in_progress'].includes(claim.state)) continue;

  const anchor = claim.state === 'claimed'
    ? claimedRunStartupAnchor(claim)
    : (claim.last_heartbeat_at ?? claim.started_at ?? claim.claimed_at);
  const idleMs = anchor ? nowMs - new Date(anchor).getTime() : NaN;
  if (Number.isNaN(idleMs)) continue;
  if (claim.input_state === 'awaiting_input') continue;
  if (claim.state === 'claimed' && !claim.task_envelope_sent_at) continue;

  const isStale = claim.state === 'claimed'
    ? idleMs >= staleStartThresholdMs
    : idleMs >= staleProgressThresholdMs;
  if (!isStale) continue;
  (checks.staleActiveClaims as unknown[]).push({
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

(checks.lifecycleIssues as unknown[]) = detectLifecycleIssues(STATE_DIR);

const summary = {
  ok:
    gitRepo &&
    stateErrors.length === 0 &&
    Object.values(checks.providerBinaries as Record<string, unknown>).every((c: unknown) => (c as Record<string, unknown>).ok) &&
    (checks.staleLinkedWorkers as unknown[]).length === 0 &&
    (checks.orphanedActiveClaims as unknown[]).length === 0 &&
    (checks.staleActiveClaims as unknown[]).length === 0 &&
    (checks.lifecycleIssues as unknown[]).length === 0 &&
    sandboxDeps.ok &&
    memoryHealth.ok &&
    runtimeSchema.ok &&
    (legacyLayout?.ok ?? true) &&
    (projectHealth?.ok ?? true) &&
    migratedTo === null,
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
console.log(formatProjectIdentity(projectHealth?.project ?? null));
for (const error of projectHealth?.errors ?? []) console.log(`  error: ${error}`);
for (const warning of projectHealth?.warnings ?? []) console.log(`  warning: ${warning}`);
if (migratedTo) console.log(`  error: this legacy state was migrated to project ${migratedTo.project_name} (${migratedTo.project_id}); use --project=${migratedTo.project_id}`);
console.log(`registered_workers: ${summary.registered_workers}`);
console.log(`active_claims: ${summary.active_claims}`);
console.log(`git_repo: ${String(gitRepo)}`);
if (!gitRepo) {
  console.log('  Not inside a git repository. Worktree-based task isolation requires git. Run `git init` to fix.');
}
console.log('');

console.log('provider binaries available');
if (Object.keys(checks.providerBinaries as Record<string, unknown>).length === 0) {
  console.log('  (no registered providers)');
} else {
  for (const [provider, result] of Object.entries(checks.providerBinaries as Record<string, unknown>)) {
    const r = result as Record<string, unknown>;
    console.log(`  ${provider}: ok=${String(r.ok)} binary=${String(r.binary)}`);
    if (!r.ok && r.detail) console.log(`    detail: ${typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}`);
  }
}

console.log('');
console.log(`stale linked workers: ${(checks.staleLinkedWorkers as unknown[]).length}`);
for (const w of checks.staleLinkedWorkers as Array<Record<string, unknown>>) {
  console.log(`  ${String(w.agent_id)} ${String(w.status)} ${String(w.session_handle)}`);
}

console.log('');
console.log(`orphaned active claims: ${(checks.orphanedActiveClaims as unknown[]).length}`);
for (const c of checks.orphanedActiveClaims as Array<Record<string, unknown>>) {
  console.log(`  ${String(c.run_id)} task=${String(c.task_ref)} agent=${String(c.agent_id)} owner_status=${String(c.owner_status)}`);
}

console.log('');
console.log(`stale active claims: ${(checks.staleActiveClaims as unknown[]).length}`);
for (const c of checks.staleActiveClaims as Array<Record<string, unknown>>) {
  console.log(`  ${String(c.run_id)} task=${String(c.task_ref)} state=${String(c.claim_state)} idle=${String(c.idle_seconds)}s threshold=${String(c.threshold_seconds)}s`);
  console.log(`    hint: ${String(c.hint)}`);
}

console.log('');
console.log(`state errors: ${stateErrors.length}`);
for (const error of stateErrors) {
  console.log(`  ${error}`);
}

console.log('');
const lifecycleIssues = checks.lifecycleIssues as LifecycleIssue[];
console.log(`lifecycle issues: ${lifecycleIssues.length}`);
for (const issue of lifecycleIssues) {
  console.log(`  ${issue.code} ${issue.message}`);
  if (issue.hint) console.log(`    hint: ${issue.hint}`);
}

console.log('');
const sd = checks.sandboxDependencies as ReturnType<typeof checkSandboxDependencies>;
if (sd.skipped) {
  console.log(`sandbox dependencies: skipped (${sd.reason})`);
} else {
  console.log(`sandbox dependencies: ok=${String(sd.ok)}`);
  for (const dep of sd.missing) {
    console.log(`  missing: ${dep}`);
    console.log(`    Ubuntu/Debian: sudo apt-get install bubblewrap socat`);
    console.log(`    Fedora:        sudo dnf install bubblewrap socat`);
  }
}
if (sandboxControlSocket.warning) console.log(`  warning: ${sandboxControlSocket.warning}`);

console.log('');
const mh = checks.memoryHealth as ReturnType<typeof validateMemoryDb>;
console.log(`memory health: ok=${String(mh.ok)}`);
for (const msg of mh.messages) {
  console.log(`  ${msg}`);
}

console.log('');
console.log(`runtime schema: ok=${String(runtimeSchema.ok)} version=${String(runtimeSchema.version)}`);
for (const message of runtimeSchema.messages) console.log(`  ${message}`);

if (legacyLayout) {
  console.log('');
  console.log(`error: ${legacyLayout.message}`);
}

if (!summary.ok) {
  console.log('');
  console.log('Suggested fixes:');
  console.log('  1. Install missing provider binaries (npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli)');
  console.log('  2. orc worker-clearall');
  console.log('  3. orc runs-active --json');
  console.log('  4. orc status --json');
  console.log('  5. Fix lifecycle invariant violations before dispatch continues');
  process.exit(1);
}

console.log('');
console.log('All checks passed.');

function isGitRepo(cwd?: string): boolean {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'pipe', ...(cwd ? { cwd } : {}) });
    return true;
  } catch {
    return false;
  }
}

function checkProviderBinary(provider: string) {
  const binary = (PROVIDER_BINARIES)[provider] ?? provider;
  const packageName = (PROVIDER_PACKAGES)[provider];
  const ok = isBinaryAvailable(binary);
  const installHint = packageName ? `npm install -g ${packageName}` : null;
  return {
    ok,
    binary,
    package: packageName ?? null,
    detail: ok ? '' : (installHint ? `Run: ${installHint}` : `Binary '${binary}' not found on PATH`),
  };
}

function safeRead<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

