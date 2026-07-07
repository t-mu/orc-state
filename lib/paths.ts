import { join, resolve } from 'node:path';
import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolveOrchestrationRoot, resolveTargetRepoRoot, isSiblingLayout } from './repoRoot.ts';
import { logger } from './logger.ts';

// Orchestration root: owns the config, state dir, backlog, plans, and
// worktrees. In the single-repo (attached) layout this is the repo root.
// With ORC_STATE_DIR set, the root is its parent — mirroring the
// ORC_CONFIG_FILE convention below — so importing this module makes no git
// calls when the ambient dir overrides are present (worker sessions, tests
// that mock node:child_process).
export const ORCHESTRATION_ROOT = process.env.ORC_STATE_DIR
  ? resolve(process.env.ORC_STATE_DIR, '..')
  : resolveOrchestrationRoot();

export const STATE_DIR = process.env.ORC_STATE_DIR
  ? resolve(process.env.ORC_STATE_DIR)
  : resolve(ORCHESTRATION_ROOT, '.orc-state');

export const EVENTS_FILE = resolve(STATE_DIR, 'events.db');
// Config lives at the orchestration root (parent of .orc-state/), not inside
// the state dir. Use ORC_CONFIG_FILE to override the path explicitly.
export const ORC_CONFIG_FILE = process.env.ORC_CONFIG_FILE
  ? resolve(process.env.ORC_CONFIG_FILE)
  : resolve(STATE_DIR, '..', 'orc-state.config.json');
export const RUN_WORKTREES_FILE = resolve(STATE_DIR, 'run-worktrees.json');

// Target repo root: the repository whose product code runs operate on.
// Equals ORCHESTRATION_ROOT unless the config sets target_repo (sibling layout).
export const TARGET_REPO_ROOT = resolveTargetRepoRoot(ORC_CONFIG_FILE, ORCHESTRATION_ROOT);

// Sibling layout is active when the operator has configured a `target_repo`
// (in orc-state.config.json) that resolves to a different directory from the
// orchestration home. This is config-driven, NOT inferred from root divergence
// — ORC_REPO_ROOT (a forcing override) and ORC_STATE_DIR can make the roots
// differ without a real sibling target, which must not enable sibling mode.
export const IS_SIBLING_LAYOUT = isSiblingLayout(ORC_CONFIG_FILE, ORCHESTRATION_ROOT);

// ─── Repo-root call-site classification (authoritative; task 185) ────────────
// Every consumer of a "repo root" is one of two kinds. This table is the
// authority tasks 186/188/191 rely on; it lives here, beside the two root
// constants, because those are what each consumer imports. In the single-repo
// (attached) layout all three of ORCHESTRATION_ROOT, TARGET_REPO_ROOT, and
// resolveRepoRoot() resolve to the same directory, so the split below is a
// no-op there and only diverges once a `target_repo` is configured.
//
// ORCHESTRATION-ROOT consumers — framework home (orc binary, specs, plans,
// config, state). These are correct as-is and were NOT changed by task 185:
//   lib/paths.ts        STATE_DIR, EVENTS_FILE, RUN_WORKTREES_FILE,
//                       WORKTREES_DIR, BACKLOG_DOCS_DIR, PLANS_DIR, ORC_CONFIG_FILE
//   lib/planSpecTask.ts resolveRepoRoot() fallback → plans/backlog/staging dirs
//   coordinator.ts      resolveOrcBinSh(REPO_ROOT)           (orc binary lookup)
//   coordinator.ts      relative(REPO_ROOT, source_path)     (backlog spec path math)
//   coordinator.ts      repoRoot: REPO_ROOT → worker env     (orc bin/ctx for workers)
//   mcp/handlers.ts     PLANS_DIR / BACKLOG_DOCS_DIR / RUN_WORKTREES_FILE
//   mcp/handlers.ts     repoRoot = ORC_REPO_ROOT ?? join(stateDir,'..')
//                       (scout/agent working dir + orc bin; no git ops)
//   NOTE: coordinator's REPO_ROOT is still resolveRepoRoot(), NOT the paths.ts
//   ORCHESTRATION_ROOT constant. They coincide in production (coordinator cwd
//   is the orchestration root) but can diverge in tests that set ORC_STATE_DIR
//   to a temp dir whose parent is not a git root. Left on resolveRepoRoot() in
//   task 185 to preserve behavior; reconciling the two anchors is deferred and
//   only matters if that divergence ever becomes load-bearing.
//
// TARGET-REPO consumers — git operations on product history/worktrees:
//   coordinator.ts      branchContainsMain / pushMain / mergeTaskBranch
//                       → MIGRATED to TARGET_REPO_ROOT in task 185.
//                       mergeTaskBranch has NO coordinator-side conflict
//                       recovery: on conflict it throws and the caller marks
//                       the run finalize-blocked (manual recovery), so there is
//                       no additional git op needing classification here.
//   lib/runWorktree.ts  git worktree add/remove/branch (cwd)   → task 186
//   lib/gitHosts/github.ts  gh/git via implicit process.cwd()  → task 186
//   lib/gitignore.ts    ensureGitignore (must skip target repo) → task 188
//   cli/doctor.ts, cli/preflight.ts, cli/init.ts  git-dir probes → task 191
// Deferred consumers stay on resolveRepoRoot()/process.cwd() (== target root in
// single-repo mode) and are handed to the tasks that own their test rewrites.
// ─────────────────────────────────────────────────────────────────────────────

export const WORKTREES_DIR = process.env.ORC_WORKTREES_DIR
  ? resolve(process.env.ORC_WORKTREES_DIR)
  : resolve(ORCHESTRATION_ROOT, '.worktrees');

export const BACKLOG_DOCS_DIR = process.env.ORC_BACKLOG_DIR
  ? resolve(process.env.ORC_BACKLOG_DIR)
  : resolve(ORCHESTRATION_ROOT, 'backlog');

export const PLANS_DIR = process.env.ORC_PLANS_DIR
  ? resolve(process.env.ORC_PLANS_DIR)
  : resolve(ORCHESTRATION_ROOT, 'plans');

/** Path to per-agent hook-events NDJSON file written by the Notification hook. */
export function hookEventPath(agentId: string): string {
  return join(STATE_DIR, 'pty-hook-events', `${agentId}.ndjson`);
}

/**
 * Atomically consume hook events for an agent.
 *
 * Protocol: rename → read → delete. The rename is atomic on POSIX and moves
 * the file out of the hook writer's append path, so no events are lost even
 * if the hook fires while the coordinator is reading.
 *
 * Returns parsed event objects, or an empty array if no file exists.
 */
export function consumeHookEvents(agentId: string): Array<{ type: string; message: string; ts: string }> {
  const src = hookEventPath(agentId);
  if (!existsSync(src)) return [];
  const processing = `${src}.processing`;
  try {
    renameSync(src, processing);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error('[paths] unexpected error renaming hook events file:', err);
    }
    // File disappeared between existsSync and rename (consumed by another tick or stop()).
    return [];
  }
  let lines: string[] = [];
  try {
    lines = readFileSync(processing, 'utf8').split('\n').filter(Boolean);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error('[paths] unexpected error reading hook events file:', err);
    }
    /* read failed — file was removed externally */
  }
  try { unlinkSync(processing); } catch { /* already gone */ }
  const events: Array<{ type: string; message: string; ts: string }> = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { type?: string; message?: string; ts?: string };
      events.push({
        type: typeof parsed.type === 'string' ? parsed.type : 'unknown',
        message: typeof parsed.message === 'string' ? parsed.message : '',
        ts: typeof parsed.ts === 'string' ? parsed.ts : '',
      });
    } catch { /* skip malformed line */ }
  }
  return events;
}
