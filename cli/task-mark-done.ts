#!/usr/bin/env node
/**
 * cli/task-mark-done.ts
 * Usage: orc task-mark-done <task_ref> [--actor-id=<id>]
 *
 * Single-action task completion: updates the markdown spec frontmatter and
 * runtime backlog state to status: done, then emits the task_updated event.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { flag } from '../lib/args.ts';
import { withLock } from '../lib/lock.ts';
import { atomicWriteJson } from '../lib/atomicWrite.ts';
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { BACKLOG_DOCS_DIR, RUN_WORKTREES_FILE, STATE_DIR } from '../lib/paths.ts';
import { readBacklog, readClaims, findTask } from '../lib/stateReader.ts';
import { discoverActiveTaskSpecs } from '../lib/backlogSync.ts';
import { cliError } from './shared.ts';
import type { RunWorktreesState } from '../types/run-worktrees.ts';

// Resolve the backlog docs directory for spec writes.
// Workers run inside worktrees where backlog/ is a separate copy of the specs.
// Writing to the worktree copy ensures the status update is included in the
// worker's branch and merged naturally by the coordinator — keeping the main
// checkout clean so `git merge` does not fail on dirty files.
//
// Resolution order:
// 1. Look up the active run worktree for the task (from run-worktrees.json via
//    claims.json). This is the most robust path — it works even when the shell
//    CWD has been reset to the main checkout by the harness.
// 2. Fall back to CWD-based detection (cwd/backlog exists and differs from
//    canonical BACKLOG_DOCS_DIR).
// 3. Fall back to BACKLOG_DOCS_DIR (main checkout).
function resolveEffectiveBacklogDir(taskRef: string): string {
  // Strategy 1: look up the active worktree from runtime state.
  const worktreeBacklog = resolveWorktreeBacklogForTask(taskRef);
  if (worktreeBacklog) return worktreeBacklog;

  // Strategy 2: CWD-based detection (worker is cd'd into worktree).
  const cwdBacklog = resolve(process.cwd(), 'backlog');
  if (existsSync(cwdBacklog) && resolve(cwdBacklog) !== resolve(BACKLOG_DOCS_DIR)) {
    return cwdBacklog;
  }

  // Strategy 3: main checkout.
  return BACKLOG_DOCS_DIR;
}

// Find the worktree backlog/ directory for a task by looking up claims → run worktrees.
function resolveWorktreeBacklogForTask(taskRef: string): string | null {
  try {
    const claims = readClaims(STATE_DIR);
    const activeClaim = claims.claims.find(
      (c) => c.task_ref === taskRef && (c.state === 'claimed' || c.state === 'in_progress'),
    );
    if (!activeClaim) return null;

    const worktrees = JSON.parse(readFileSync(RUN_WORKTREES_FILE, 'utf8')) as RunWorktreesState;
    const entry = worktrees.runs.find((r) => r.run_id === activeClaim.run_id);
    if (!entry?.worktree_path) return null;

    const backlogDir = join(entry.worktree_path, 'backlog');
    if (existsSync(backlogDir) && resolve(backlogDir) !== resolve(BACKLOG_DOCS_DIR)) {
      return backlogDir;
    }
  } catch {
    // State files unreadable — fall through to CWD/main strategies.
  }
  return null;
}

const NON_COMPLETABLE_STATUSES = new Set(['todo', 'blocked', 'released', 'cancelled']);

const taskRef = process.argv.slice(2).find((a) => !a.startsWith('-'));
const actorId = flag('actor-id') ?? 'human';

if (!taskRef) {
  console.error('Usage: orc task-mark-done <task_ref> [--actor-id=<id>]');
  process.exit(1);
}

try {
  withLock(join(STATE_DIR, '.lock'), () => {
    const now = new Date().toISOString();
    const backlogPath = join(STATE_DIR, 'backlog.json');

    const backlog = readBacklog(STATE_DIR);
    const task = findTask(backlog, taskRef);
    const previousStatus = task?.status ?? 'unregistered';
    if (!task) {
      throw new Error(`task not found: ${taskRef}`);
    }
    if (NON_COMPLETABLE_STATUSES.has(task.status)) {
      throw new Error(`task ${taskRef} must be claimed or in_progress before completion (got: ${task.status})`);
    }

    // Step 1: Update the markdown spec frontmatter to status: done.
    // Resolves the effective backlog directory by checking the active run worktree
    // first (robust against CWD resets), then CWD, then main checkout.
    const effectiveBacklogDir = resolveEffectiveBacklogDir(taskRef);
    const specs = discoverActiveTaskSpecs(effectiveBacklogDir);
    const spec = specs.find((s) => s.ref === taskRef);
    if (!spec) {
      throw new Error(`Task spec not found in backlog/: ${taskRef}`);
    }
    if (spec.status !== 'done') {
      const specPath = join(effectiveBacklogDir, spec.file);
      const content = readFileSync(specPath, 'utf8');
      const updated = content.replace(/^(status:\s*).+$/m, '$1done');
      if (updated === content) {
        throw new Error(`Could not locate status field in frontmatter of ${spec.file}`);
      }
      writeFileSync(specPath, updated, 'utf8');
    }

    // Step 2: Transition runtime state directly. Generic backlog sync intentionally
    // does not overwrite active task statuses, so completion must update runtime here.
    if (task.status !== 'done') {
      task.status = 'done';
      task.updated_at = now;
      delete task.blocked_reason;
      atomicWriteJson(backlogPath, backlog);
    }

    // Step 3: Emit event
    appendSequencedEvent(
      STATE_DIR,
      {
        ts: now,
        event: 'task_updated',
        actor_type: actorId === 'human' ? 'human' : 'agent',
        actor_id: actorId,
        task_ref: taskRef,
        payload: { status: 'done', previous_status: previousStatus, fields: ['status'] },
      },
      { lockAlreadyHeld: true },
    );

    console.log(`task marked done: ${taskRef} (was: ${previousStatus})`);
  });
} catch (err) {
  cliError(err);
}
