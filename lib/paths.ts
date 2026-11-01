import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { logger } from './logger.ts';
import { resolveActiveProject, type ActiveProject } from './projectContext.ts';
import { projectDataHome } from './projectRegistry.ts';

// The registered project this process operates on: it keeps every harness
// artifact in its external state directory and runs Git against its
// registered target repository. Null when no project is selected.
export const ACTIVE_PROJECT: ActiveProject | null = resolveActiveProject();

// The project's state directory. Without a project, ORC_STATE_DIR names the
// state directory directly (tests); otherwise it is a placeholder under the
// data home that no project owns, and every command that writes state refuses
// to run (assertProjectMode). Importing this module makes no git calls when
// ORC_STATE_DIR is set and no registry exists (tests that mock node:child_process).
export const STATE_DIR = ACTIVE_PROJECT
  ? ACTIVE_PROJECT.stateDir
  : process.env.ORC_STATE_DIR ? resolve(process.env.ORC_STATE_DIR) : join(projectDataHome(), 'no-project');

export const EVENTS_FILE = resolve(STATE_DIR, 'events.db');

// The orc installation itself (for locating its binary).
export const ORC_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RUN_WORKTREES_FILE = resolve(STATE_DIR, 'run-worktrees.json');

// Target repo root: the repository whose product code runs operate on — the
// project's registered canonical Git root. Without a project nothing runs
// against it; it is the current directory.
export const TARGET_REPO_ROOT = ACTIVE_PROJECT ? ACTIVE_PROJECT.targetRepoRoot : process.cwd();

export const NO_PROJECT_MESSAGE = 'No registered project here. Register this repository with orc project add <git-path>, or pass --project=<id> (outside every Git repository, orc project select <id> chooses one)';

/** Only a registered project runs. */
export function assertProjectMode(): void {
  if (ACTIVE_PROJECT) return;
  throw new Error(NO_PROJECT_MESSAGE);
}

// Run worktrees live in the project state directory, outside the target working tree.
export const WORKTREES_DIR = process.env.ORC_WORKTREES_DIR
  ? resolve(process.env.ORC_WORKTREES_DIR)
  : resolve(STATE_DIR, 'worktrees');

/**
 * Path to an agent's hook-events NDJSON file in `stateDir`: written by the
 * provider hooks (hooks/orc-hook.ts) and by stop-check (`turn_end`), drained
 * only by the coordinator tick.
 */
export function hookEventPathIn(stateDir: string, agentId: string): string {
  return join(stateDir, 'pty-hook-events', `${agentId}.ndjson`);
}

/** Path to per-agent hook-events NDJSON file in this process's state directory. */
export function hookEventPath(agentId: string): string {
  return hookEventPathIn(STATE_DIR, agentId);
}

/** Read and delete a hook-events `.processing` file; [] when it is absent or unreadable. */
function drainProcessingFile(processing: string): string[] {
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
  return lines;
}

/**
 * Atomically consume the raw hook-event records for an agent.
 *
 * Protocol: rename → read → delete. The rename is atomic on POSIX and moves
 * the file out of the hook writer's append path, so no events are lost even
 * if the hook fires while the coordinator is reading. A `.processing` file
 * left by a coordinator that crashed between the rename and the delete is
 * drained first (its records are older), so the next rename cannot overwrite it.
 *
 * The read is destructive, so this has exactly one caller:
 * `drainHookEvents` (lib/hookEventBus.ts), driven by the coordinator tick.
 * It returns every line that parses to a JSON object, in file order;
 * malformed lines are skipped with a debug log. Typing and dispatch by
 * `type` happen in the bus.
 */
export function consumeHookEvents(agentId: string): Array<Record<string, unknown>> {
  const src = hookEventPath(agentId);
  const processing = `${src}.processing`;
  const lines = existsSync(processing) ? drainProcessingFile(processing) : [];
  if (existsSync(src)) {
    let renamed = true;
    try {
      renameSync(src, processing);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('[paths] unexpected error renaming hook events file:', err);
      }
      // File disappeared between existsSync and rename (consumed by another tick or stop()).
      renamed = false;
    }
    if (renamed) lines.push(...drainProcessingFile(processing));
  }
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
