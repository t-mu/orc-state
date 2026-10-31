import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolveOrchestrationRoot } from './repoRoot.ts';
import { logger } from './logger.ts';
import { resolveActiveProject, type ActiveProject } from './projectContext.ts';

// Project mode (plan 3): a registered project keeps every harness artifact in
// its external state directory and runs Git against its registered target
// repository. Null in a legacy (unmigrated) attached installation.
export const ACTIVE_PROJECT: ActiveProject | null = resolveActiveProject();

// Orchestration root: owns the state dir, backlog, plans, and worktrees.
// In a legacy attached installation this is the repo root. With
// ORC_STATE_DIR set, the root is its parent, so importing this module makes
// no git calls when the ambient dir overrides are present (worker sessions, tests
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
export const RUN_WORKTREES_FILE = resolve(STATE_DIR, 'run-worktrees.json');

// Target repo root: the repository whose product code runs operate on. In
// project mode it is the registered canonical Git root; a legacy attached
// installation operates on its own root (ORC_REPO_ROOT forces it).
export const TARGET_REPO_ROOT = ACTIVE_PROJECT
  ? ACTIVE_PROJECT.targetRepoRoot
  : process.env.ORC_REPO_ROOT ? resolve(process.env.ORC_REPO_ROOT) : ORCHESTRATION_ROOT;

/** Only a registered project runs: a legacy (attached or sibling) installation must be migrated first. */
export function assertProjectMode(): void {
  if (ACTIVE_PROJECT) return;
  throw new Error(`No registered project here. Legacy .orc-state installations no longer run: migrate one with orc project migrate ${ORCHESTRATION_ROOT} --execute, or register a repository with orc project add <git-path> (or pass --project=<id>)`);
}

// ─── Repo-root call-site classification (authoritative; task 185) ────────────
// Every consumer of a "repo root" is one of two kinds. This table is the
// authority tasks 186/188/191 rely on; it lives here, beside the two root
// constants, because those are what each consumer imports. The orchestration
// root is the external project state directory and the target is the
// registered repository.
//
// ORCHESTRATION-ROOT consumers — framework home (orc binary, state). These are correct as-is and were NOT changed by task 185:
//   lib/paths.ts        STATE_DIR, EVENTS_FILE, RUN_WORKTREES_FILE,
//                       WORKTREES_DIR
//   coordinator.ts      resolveOrcBinSh(ORC_PACKAGE_ROOT)    (orc binary lookup)
//   coordinator.ts      repoRoot: ORC_PACKAGE_ROOT → worker env (orc bin/ctx for workers)
//   mcp/handlers.ts     RUN_WORKTREES_FILE
//   mcp/handlers.ts     repoRoot = ORC_REPO_ROOT || TARGET_REPO_ROOT
//                       (scout/agent working dir + orc bin; no git ops)
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
 * Atomically consume the raw hook-event records for an agent.
 *
 * Protocol: rename → read → delete. The rename is atomic on POSIX and moves
 * the file out of the hook writer's append path, so no events are lost even
 * if the hook fires while the coordinator is reading.
 *
 * The read is destructive, so this has exactly one caller:
 * `drainHookEvents` (lib/hookEventBus.ts), driven by the coordinator tick.
 * It returns every line that parses to a JSON object, in file order;
 * malformed lines are skipped with a debug log. Typing and dispatch by
 * `type` happen in the bus.
 */
export function consumeHookEvents(agentId: string): Array<Record<string, unknown>> {
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
  const records: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      logger.debug(`[paths] skipping malformed hook event line for ${agentId}: ${line.slice(0, 200)}`);
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.debug(`[paths] skipping non-object hook event line for ${agentId}: ${line.slice(0, 200)}`);
      continue;
    }
    records.push(parsed as Record<string, unknown>);
  }
  return records;
}
