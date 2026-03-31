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
import { BACKLOG_DOCS_DIR, STATE_DIR } from '../lib/paths.ts';
import { readBacklog, findTask } from '../lib/stateReader.ts';
import { discoverActiveTaskSpecs } from '../lib/backlogSync.ts';
import { cliError } from './shared.ts';

// Resolve the backlog docs directory for spec writes.
// Workers run inside worktrees where backlog/ is a separate copy of the specs.
// Writing to the worktree copy ensures the status update is included in the
// worker's branch and merged naturally by the coordinator.
// When cwd/backlog exists and differs from the canonical BACKLOG_DOCS_DIR,
// prefer it — the caller is in a worktree.
function resolveEffectiveBacklogDir(): string {
  const cwdBacklog = resolve(process.cwd(), 'backlog');
  if (existsSync(cwdBacklog) && resolve(cwdBacklog) !== resolve(BACKLOG_DOCS_DIR)) {
    return cwdBacklog;
  }
  return BACKLOG_DOCS_DIR;
}
const effectiveBacklogDir = resolveEffectiveBacklogDir();

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
    // Uses effectiveBacklogDir (cwd/backlog if it exists, else canonical BACKLOG_DOCS_DIR)
    // so workers in worktrees write to their local copy and include the update in their branch.
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
