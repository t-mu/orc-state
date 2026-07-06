import { join, resolve } from 'node:path';
import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolveOrchestrationRoot, resolveTargetRepoRoot } from './repoRoot.ts';
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
