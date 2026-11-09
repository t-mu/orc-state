#!/usr/bin/env node
/**
 * cli/doctor.ts
 * Usage: node cli/doctor.ts [--json]
 */
import { exitAfterFlush, printJson } from './shared.ts';
import { ACTIVE_PROJECT, STATE_DIR } from '../lib/paths.ts';
import { formatProjectIdentity } from '../lib/projectHealth.ts';
import { boolFlag, intFlag } from '../lib/args.ts';
import { runDoctor } from '../lib/doctor.ts';

const asJson = boolFlag('json');

const summary = await runDoctor(STATE_DIR, {
  project: ACTIVE_PROJECT,
  staleStartThresholdMs: intFlag('stale-start-ms', 5 * 60 * 1000),
  staleProgressThresholdMs: intFlag('stale-progress-ms', 20 * 60 * 1000),
});
const { checks } = summary;
const { gitRepo, stateErrors, sandboxControlSocket, runtimeSchema, coordinatorLock, coordinatorCode, tmux, projectSelection } = checks;
const projectHealth = checks.project;

if (asJson) {
  printJson(summary);
  await exitAfterFlush(summary.ok ? 0 : 1);
}

console.log('Orchestrator Doctor');
console.log('-------------------');
console.log(formatProjectIdentity(projectHealth?.project ?? null));
for (const error of projectHealth?.errors ?? []) console.log(`  error: ${error}`);
for (const warning of projectHealth?.warnings ?? []) console.log(`  warning: ${warning}`);
console.log(`registered_workers: ${summary.registered_workers}`);
console.log(`active_claims: ${summary.active_claims}`);
console.log(`git_repo: ${String(gitRepo)}`);
if (!gitRepo) {
  console.log('  Not inside a git repository. Worktree-based task isolation requires git. Run `git init` to fix.');
}
console.log('');

console.log('provider binaries available');
if (Object.keys(checks.providerBinaries).length === 0) {
  console.log('  (no registered providers)');
} else {
  for (const [provider, r] of Object.entries(checks.providerBinaries)) {
    console.log(`  ${provider}: ok=${String(r.ok)} binary=${r.binary}`);
    if (!r.ok && r.detail) console.log(`    detail: ${r.detail}`);
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
  console.log(`  ${String(c.run_id)} task=${String(c.task_ref)} agent=${String(c.agent_id)} owner_status=${String(c.owner_status)}`);
}

console.log('');
console.log(`stale active claims: ${checks.staleActiveClaims.length}`);
for (const c of checks.staleActiveClaims) {
  console.log(`  ${String(c.run_id)} task=${String(c.task_ref)} state=${String(c.claim_state)} idle=${String(c.idle_seconds)}s threshold=${String(c.threshold_seconds)}s`);
  console.log(`    hint: ${String(c.hint)}`);
}

console.log('');
console.log(`state errors: ${stateErrors.length}`);
for (const error of stateErrors) {
  console.log(`  ${error}`);
}

console.log('');
const lifecycleIssues = checks.lifecycleIssues;
console.log(`lifecycle issues: ${lifecycleIssues.length}`);
for (const issue of lifecycleIssues) {
  console.log(`  ${issue.code} ${issue.message}`);
  if (issue.hint) console.log(`    hint: ${issue.hint}`);
}

console.log('');
const sd = checks.sandboxDependencies;
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
const mh = checks.memoryHealth;
console.log(`memory health: ok=${String(mh.ok)}`);
for (const msg of mh.messages) {
  console.log(`  ${msg}`);
}

console.log('');
console.log(`runtime schema: ok=${String(runtimeSchema.ok)} version=${String(runtimeSchema.version)}`);
for (const message of runtimeSchema.messages) console.log(`  ${message}`);

console.log('');
console.log(`coordinator lock: ok=${String(coordinatorLock.problem === null)}`);
if (coordinatorLock.problem) console.log(`  ${coordinatorLock.problem}`);

console.log('');
console.log(`coordinator code: ${coordinatorCode.warning ? 'stale' : 'ok'}`);
if (coordinatorCode.warning) console.log(`  warning: ${coordinatorCode.warning}`);

console.log('');
console.log(`tmux: ok=${String(tmux.ok)}${tmux.version ? ` version=${tmux.version}` : ''}`);
if (tmux.problem) console.log(`  error: ${tmux.problem}`);

if (projectSelection) {
  console.log('');
  console.log(`error: ${projectSelection.message}`);
}

if (!summary.ok) {
  console.log('');
  console.log('Suggested fixes:');
  console.log('  1. Install missing provider binaries (npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli)');
  console.log('  2. orc worker-gc');
  console.log('  3. orc runs --json');
  console.log('  4. orc status --json');
  console.log('  5. Fix lifecycle invariant violations before dispatch continues');
  process.exit(1);
}

console.log('');
console.log('All checks passed.');
