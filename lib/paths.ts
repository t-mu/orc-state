import { join, resolve } from 'node:path';
import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolveRepoRoot } from './repoRoot.ts';
import { logger } from './logger.ts';

export const STATE_DIR = process.env.ORCH_STATE_DIR
  ? resolve(process.env.ORCH_STATE_DIR)
  : resolve(resolveRepoRoot(), '.orc-state');

export const EVENTS_FILE = resolve(STATE_DIR, 'events.db');
// Config lives at repo root (parent of .orc-state/), not inside the state dir.
// Use ORC_CONFIG_FILE to override the path explicitly.
export const ORCHESTRATOR_CONFIG_FILE = process.env.ORC_CONFIG_FILE
  ? resolve(process.env.ORC_CONFIG_FILE)
  : resolve(STATE_DIR, '..', 'orchestrator.config.json');
export const RUN_WORKTREES_FILE = resolve(STATE_DIR, 'run-worktrees.json');

export const WORKTREES_DIR = process.env.ORC_WORKTREES_DIR
  ? resolve(process.env.ORC_WORKTREES_DIR)
  : resolve(resolveRepoRoot(), '.worktrees');

export const BACKLOG_DOCS_DIR = process.env.ORC_BACKLOG_DIR
  ? resolve(process.env.ORC_BACKLOG_DIR)
  : resolve(resolveRepoRoot(), 'backlog');

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
