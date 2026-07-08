import { isAbsolute, join, relative } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { withLock } from './lock.ts';
import { atomicWriteJson } from './atomicWrite.ts';
import { appendSequencedEvent } from './eventLog.ts';
import { readBacklog, findTask } from './stateReader.ts';
import { discoverActiveTaskSpecs } from './backlogSync.ts';
import { BACKLOG_DOCS_DIR, IS_SIBLING_LAYOUT, ORCHESTRATION_ROOT, STATE_DIR } from './paths.ts';
import { logger } from './logger.ts';

const NON_COMPLETABLE_STATUSES = new Set(['blocked', 'released', 'cancelled']);

export function markTaskDoneRuntimeOnly(
  taskRef: string,
  actorId = 'human',
  stateDir = STATE_DIR,
): void {
  withLock(join(stateDir, '.lock'), () => {
    const now = new Date().toISOString();
    const backlogPath = join(stateDir, 'backlog.json');

    const backlog = readBacklog(stateDir);
    const task = findTask(backlog, taskRef);
    const previousStatus = task?.status ?? 'unregistered';
    if (!task) {
      throw new Error(`task not found: ${taskRef}`);
    }
    if (NON_COMPLETABLE_STATUSES.has(task.status)) {
      throw new Error(`task ${taskRef} cannot transition to done from status ${task.status}`);
    }

    if (task.status !== 'done') {
      task.status = 'done';
      task.updated_at = now;
      delete task.blocked_reason;
      atomicWriteJson(backlogPath, backlog);
    }

    appendSequencedEvent(
      stateDir,
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
}

/**
 * Rewrite the leading frontmatter `status:` value to `done`. Returns the new
 * text and whether it changed, or null when the text has no frontmatter or no
 * status field. Only the leading frontmatter block is touched — a later
 * "status:" line in the task body is never matched.
 */
// Follows the same frontmatter conventions as parseSpecFrontmatter /
// discoverActiveTaskSpecs (leading `---\n ... \n---` block, LF-terminated,
// bare status token) — writeback only ever runs on specs that discovery has
// already parsed and registered, so it need not be more permissive than that.
function setFrontmatterStatusDone(text: string): { text: string; changed: boolean } | null {
  const match = /^(---\s*\n)([\s\S]*?)(\n---(?:\n|$))/.exec(text);
  if (!match) return null;
  const [full, open, body, close] = match;
  // Match the value token only (not the whole line), so the already-done guard
  // and the rewrite never depend on or clobber trailing content.
  const current = /^status:[ \t]*(\S+)/m.exec(body)?.[1];
  if (current === undefined) return null;
  if (current === 'done') return { text, changed: false };
  const newBody = body.replace(/^(status:[ \t]*)\S+/m, '$1done');
  return { text: open + newBody + close + text.slice(full.length), changed: true };
}

function orchestrationRepoIsGit(orchestrationRoot: string): boolean {
  return spawnSync('git', ['rev-parse', '--git-dir'], { cwd: orchestrationRoot, encoding: 'utf8' }).status === 0;
}

/**
 * Sibling-mode Phase 4 spec writeback (distinct from the runtime-only
 * `markTaskDoneRuntimeOnly`). In the sibling layout the worker never edits or
 * commits the task spec — product-code merges land in the target repo — so the
 * coordinator writes `status: done` into the spec under the orchestration
 * repo's backlog/ after merge and commits it there.
 *
 * No-op in the attached layout, where the worker's own spec edit is carried by
 * the merge. When the orchestration root is not a git repository, the file is
 * written and the commit is skipped. Best-effort: never throws — the caller's
 * finalization must not fail on a writeback problem.
 *
 * This is an AUDIT MIRROR, not a lifecycle-safety mechanism: it keeps the
 * spec's `status:` in sync with the runtime and gives a durable git trail. It
 * is NOT load-bearing for backlogSync convergence — the terminal-status guard
 * in backlogSync is what prevents a stale `todo` spec from demoting a merged
 * (`done`/`released`) task, so a failed or late writeback can no longer
 * re-dispatch completed work.
 *
 * Sibling detection is the config-driven `IS_SIBLING_LAYOUT` (overridable via
 * `isSibling` for tests), NOT root-equality: a worker/operator shell carries
 * ambient `ORC_REPO_ROOT` (and `ORC_HOME`) pointing at the orchestration root,
 * which collapses TARGET_REPO_ROOT onto ORCHESTRATION_ROOT — so gating on
 * `orchestrationRoot === targetRepoRoot` would make `orc task-mark-done` (and
 * any writeback from such a shell) silently no-op in a genuinely-sibling setup.
 */
export function writeSpecStatusDone(
  taskRef: string,
  {
    docsDir = BACKLOG_DOCS_DIR,
    orchestrationRoot = ORCHESTRATION_ROOT,
    isSibling = IS_SIBLING_LAYOUT,
  }: { docsDir?: string; orchestrationRoot?: string; isSibling?: boolean } = {},
): { written: boolean; committed: boolean } {
  if (!isSibling) return { written: false, committed: false };

  let entry;
  try {
    entry = discoverActiveTaskSpecs(docsDir).find((spec) => spec.ref === taskRef) ?? null;
  } catch (err) {
    logger.warn(`[specWriteback] failed to scan specs under ${docsDir}: ${(err as Error).message}`);
    return { written: false, committed: false };
  }
  if (!entry) {
    logger.warn(`[specWriteback] no spec file found for ${taskRef} under ${docsDir}`);
    return { written: false, committed: false };
  }

  const specPath = join(docsDir, entry.file);
  let result: { text: string; changed: boolean } | null;
  try {
    result = setFrontmatterStatusDone(readFileSync(specPath, 'utf8'));
  } catch (err) {
    logger.warn(`[specWriteback] cannot read spec ${specPath}: ${(err as Error).message}`);
    return { written: false, committed: false };
  }
  if (!result) {
    logger.warn(`[specWriteback] spec ${specPath} has no frontmatter status to update`);
    return { written: false, committed: false };
  }
  if (!result.changed) return { written: false, committed: false };

  try {
    writeFileSync(specPath, result.text);
  } catch (err) {
    logger.warn(`[specWriteback] failed to write spec ${specPath}: ${(err as Error).message}`);
    return { written: false, committed: false };
  }

  if (!orchestrationRepoIsGit(orchestrationRoot)) {
    return { written: true, committed: false };
  }

  const relPath = isAbsolute(specPath) ? relative(orchestrationRoot, specPath) : specPath;
  const staged = spawnSync('git', ['add', relPath], { cwd: orchestrationRoot, encoding: 'utf8' });
  if (staged.status !== 0) {
    logger.warn(`[specWriteback] git add failed for ${taskRef}: ${(staged.stderr || staged.stdout || '').trim()}`);
    return { written: true, committed: false };
  }
  const committed = spawnSync('git', ['commit', '-m', `chore(backlog): ${taskRef} done`, '--', relPath], {
    cwd: orchestrationRoot,
    encoding: 'utf8',
  });
  if (committed.status !== 0) {
    logger.warn(`[specWriteback] git commit failed for ${taskRef}: ${(committed.stderr || committed.stdout || '').trim()}`);
    return { written: true, committed: false };
  }
  return { written: true, committed: true };
}
