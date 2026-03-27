#!/usr/bin/env node
/**
 * cli/run-info.ts
 * Usage: orc run-info <run_id> [--json]
 *
 * Print a summary for a given run_id.
 */
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { STATE_DIR } from '../lib/paths.ts';
import { readClaims, readBacklog, findTask } from '../lib/stateReader.ts';
import { claimedRunStartupAnchor } from '../lib/runActivity.ts';

const asJson = process.argv.includes('--json');
const runId = process.argv.slice(2).find((a) => !a.startsWith('-'));

if (!runId) {
  console.error('Usage: orc run-info <run_id> [--json]');
  process.exit(1);
}

const claimsState = readClaims(STATE_DIR);
const claim = claimsState.claims.find((c) => c.run_id === runId);

if (!claim) {
  console.error(`run not found: ${runId}`);
  process.exit(1);
}

// Look up task title
const backlog = readBacklog(STATE_DIR);
const task = findTask(backlog, claim.task_ref);
const taskTitle = task?.title ?? null;

// Look up worktree path
let worktreePath: string | null = null;
const runWorktreesPath = join(STATE_DIR, 'run-worktrees.json');
if (existsSync(runWorktreesPath)) {
  try {
    const data = JSON.parse(readFileSync(runWorktreesPath, 'utf8')) as { runs?: Array<{ run_id: string; worktree_path?: string }> };
    const entry = (data.runs ?? []).find((e) => e.run_id === runId);
    worktreePath = entry?.worktree_path ?? null;
  } catch {
    // ignore
  }
}

// Compute idle
const now = Date.now();
const idleAnchor = claim.last_heartbeat_at
  ?? claim.started_at
  ?? (claim.state === 'claimed' ? claimedRunStartupAnchor(claim) : (claim.task_envelope_sent_at ?? claim.claimed_at ?? null));
const idleSec = idleAnchor ? Math.round((now - new Date(idleAnchor).getTime()) / 1000) : null;

if (asJson) {
  console.log(JSON.stringify({ ...claim, task_title: taskTitle, worktree_path: worktreePath }, null, 2));
  process.exit(0);
}

console.log(`Run: ${claim.run_id}`);
console.log(`  task:        ${claim.task_ref}${taskTitle ? ` — ${taskTitle}` : ''}`);
console.log(`  agent:       ${claim.agent_id}`);
console.log(`  state:       ${claim.state}`);
console.log(`  envelope:    ${claim.task_envelope_sent_at ?? 'not yet'}`);
console.log(`  started:     ${claim.started_at ?? 'not yet'}`);
console.log(`  idle:        ${idleSec ?? '?'}s`);
console.log(`  worktree:    ${worktreePath ?? 'none'}`);
console.log(`  finalize:    ${claim.finalization_state ?? 'n/a'}`);
console.log(`  input_state: ${claim.input_state ?? 'none'}`);
