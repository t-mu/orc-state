import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolveOrchestrationRoot, legacySiblingTarget } from './repoRoot.ts';
import { logger } from './logger.ts';
import { resolveActiveProject, type ActiveProject } from './projectContext.ts';

// Project mode (plan 3): a registered project keeps every harness artifact in
// its external state directory and runs Git against its registered target
// repository. Null in a legacy (unmigrated) attached installation.
export const ACTIVE_PROJECT: ActiveProject | null = resolveActiveProject();

// Orchestration root: owns the config, state dir, backlog, plans, and
// worktrees. In a legacy attached installation this is the repo root.
// With ORC_STATE_DIR set, the root is its parent — mirroring the
// ORC_CONFIG_FILE convention below — so importing this module makes no git
// calls when the ambient dir overrides are present (worker sessions, tests
// that mock node:child_process). In project mode it is the project state dir.
export const ORCHESTRATION_ROOT = ACTIVE_PROJECT
  ? ACTIVE_PROJECT.stateDir
  : process.env.ORC_STATE_DIR
    ? resolve(process.env.ORC_STATE_DIR, '..')
    : resolveOrchestrationRoot();

// A selected project always uses its own state directory; an ORC_STATE_DIR
// bridge only counts when it is that directory (see resolveActiveProject).
export const STATE_DIR = ACTIVE_PROJECT
  ? ACTIVE_PROJECT.stateDir
  : process.env.ORC_STATE_DIR ? resolve(process.env.ORC_STATE_DIR) : resolve(ORCHESTRATION_ROOT, '.orc-state');

export const EVENTS_FILE = resolve(STATE_DIR, 'events.db');

// The orc installation itself (for locating its binary). In project mode the
// coordinator has no orchestration repository to find it in.
export const ORC_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Config lives at the orchestration root (parent of .orc-state/), not inside
// the state dir. Use ORC_CONFIG_FILE to override the path explicitly. A
// project has no config file; its settings come from the global registry.
export const ORC_CONFIG_FILE = process.env.ORC_CONFIG_FILE
  ? resolve(process.env.ORC_CONFIG_FILE)
  : ACTIVE_PROJECT ? resolve(STATE_DIR, 'orc-state.config.json') : resolve(STATE_DIR, '..', 'orc-state.config.json');
export const RUN_WORKTREES_FILE = resolve(STATE_DIR, 'run-worktrees.json');

// Target repo root: the repository whose product code runs operate on. In
// project mode it is the registered canonical Git root; a legacy attached
// installation operates on its own root (ORC_REPO_ROOT forces it).
export const TARGET_REPO_ROOT = ACTIVE_PROJECT
  ? ACTIVE_PROJECT.targetRepoRoot
  : process.env.ORC_REPO_ROOT ? resolve(process.env.ORC_REPO_ROOT) : ORCHESTRATION_ROOT;

// A legacy orchestration home whose config names a separate `target_repo`
// (the retired sibling layout). It must be migrated before it runs again.
export const LEGACY_SIBLING_TARGET = ACTIVE_PROJECT ? null : legacySiblingTarget(ORC_CONFIG_FILE, ORCHESTRATION_ROOT);

/** Only a registered project runs: a legacy (attached or sibling) installation must be migrated first. */
export function assertProjectMode(): void {
  if (ACTIVE_PROJECT) return;
  if (LEGACY_SIBLING_TARGET) {
    throw new Error(`${ORCHESTRATION_ROOT} is a sibling orchestration home (target_repo: ${LEGACY_SIBLING_TARGET}). Sibling layouts are retired; migrate it into a project with: orc project migrate ${ORCHESTRATION_ROOT} --execute`);
  }
  throw new Error(`No registered project here. Legacy .orc-state installations no longer run: migrate one with orc project migrate ${ORCHESTRATION_ROOT} --execute, or register a repository with orc project add <git-path> (or pass --project=<id>)`);
}

// ─── Repo-root call-site classification (authoritative; task 185) ────────────
// Every consumer of a "repo root" is one of two kinds. This table is the
// authority tasks 186/188/191 rely on; it lives here, beside the two root
// constants, because those are what each consumer imports. The orchestration
// root is the external project state directory and the target is the
// registered repository.
//
// ORCHESTRATION-ROOT consumers — framework home (orc binary, config, state). These are correct as-is and were NOT changed by task 185:
//   lib/paths.ts        STATE_DIR, EVENTS_FILE, RUN_WORKTREES_FILE,
//                       WORKTREES_DIR, ORC_CONFIG_FILE
//   coordinator.ts      resolveOrcBinSh(REPO_ROOT)           (orc binary lookup)
//   coordinator.ts      repoRoot: REPO_ROOT → worker env     (orc bin/ctx for workers)
//   mcp/handlers.ts     RUN_WORKTREES_FILE
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

// In project mode these all live in the external project state directory.
export const WORKTREES_DIR = process.env.ORC_WORKTREES_DIR
  ? resolve(process.env.ORC_WORKTREES_DIR)
  : resolve(ORCHESTRATION_ROOT, ACTIVE_PROJECT ? 'worktrees' : '.worktrees');

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
