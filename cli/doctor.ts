#!/usr/bin/env node
/**
 * cli/doctor.ts
 * Usage: node cli/doctor.ts [--json]
 */
import { execSync } from 'node:child_process';
import { STATE_DIR } from '../lib/paths.ts';
import { boolFlag, intFlag } from '../lib/args.ts';
import { isBinaryAvailable, PROVIDER_BINARIES, PROVIDER_PACKAGES } from '../lib/binaryCheck.ts';
import { readAgents, readClaims } from '../lib/stateReader.ts';
import { validateStateDir } from '../lib/stateValidation.ts';
import { detectLifecycleIssues, type LifecycleIssue } from '../lib/lifecycleDiagnostics.ts';
import { claimedRunStartupAnchor } from '../lib/runActivity.ts';
import { getOrphanedClaims } from '../lib/claimDiagnostics.ts';
import { validateBacklogSync } from './backlog-sync-check.ts';
import { checkSandboxDependencies } from '../lib/sandboxDeps.ts';
import type { Agent } from '../types/agents.ts';
import type { Claim } from '../types/claims.ts';

const asJson = boolFlag('json');
const staleStartThresholdMs = intFlag('stale-start-ms', 5 * 60 * 1000);
const staleProgressThresholdMs = intFlag('stale-progress-ms', 20 * 60 * 1000);
const nowMs = Date.now();

const gitRepo = isGitRepo();
const stateErrors = validateStateDir(STATE_DIR);
const backlogSync = safeRead(
  () => validateBacklogSync(process.env.ORC_BACKLOG_DIR ?? `${process.env.ORC_REPO_ROOT ?? process.cwd()}/backlog`, `${STATE_DIR}/backlog.json`),
  { ok: false, spec_count: 0, filtered: false, missing: [], mismatches: [] },
);
const agents: Agent[] = safeRead(() => readAgents(STATE_DIR).agents, []);
const claims: Claim[] = safeRead(() => readClaims(STATE_DIR).claims, []);
const providers = new Set(agents.map((a) => a.provider));

const sandboxDeps = checkSandboxDependencies();

const checks: Record<string, unknown> = {
  gitRepo,
  providerBinaries: {} as Record<string, unknown>,
  staleLinkedWorkers: [] as unknown[],
  orphanedActiveClaims: [] as unknown[],
  staleActiveClaims: [] as unknown[],
  lifecycleIssues: [] as unknown[],
  stateErrors,
  backlogSync,
  sandboxDependencies: sandboxDeps,
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
    backlogSync.ok &&
    Object.values(checks.providerBinaries as Record<string, unknown>).every((c: unknown) => (c as Record<string, unknown>).ok) &&
    (checks.staleLinkedWorkers as unknown[]).length === 0 &&
    (checks.orphanedActiveClaims as unknown[]).length === 0 &&
    (checks.staleActiveClaims as unknown[]).length === 0 &&
    (checks.lifecycleIssues as unknown[]).length === 0 &&
    sandboxDeps.ok,
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
console.log(`backlog sync mismatches: ${backlogSync.missing.length + backlogSync.mismatches.length}`);
for (const missing of backlogSync.missing) {
  console.log(`  missing ${missing.ref} (${missing.file})`);
}
for (const mismatch of backlogSync.mismatches) {
  console.log(`  mismatch ${mismatch.ref} ${mismatch.field}: expected "${mismatch.expected}" got "${mismatch.actual}"`);
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

function isGitRepo(): boolean {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'pipe' });
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

