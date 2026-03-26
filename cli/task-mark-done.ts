#!/usr/bin/env node
/**
 * cli/task-mark-done.ts
 * Usage: orc task-mark-done <task_ref> [--actor-id=<id>]
 *
 * Single-action task completion: updates the markdown spec frontmatter to
 * status: done, syncs orchestrator state, and emits the task_updated event.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flag } from '../lib/args.ts';
import { withLock } from '../lib/lock.ts';
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { BACKLOG_DOCS_DIR, STATE_DIR } from '../lib/paths.ts';
import { readBacklog, findTask } from '../lib/stateReader.ts';
import { discoverActiveTaskSpecs, syncBacklogFromSpecs } from '../lib/backlogSync.ts';

const taskRef = process.argv.slice(2).find((a) => !a.startsWith('-'));
const actorId = flag('actor-id') ?? 'human';

if (!taskRef) {
  console.error('Usage: orc task-mark-done <task_ref> [--actor-id=<id>]');
  process.exit(1);
}

try {
  withLock(join(STATE_DIR, '.lock'), () => {
    const now = new Date().toISOString();

    const beforeSync = readBacklog(STATE_DIR);
    const previousStatus = findTask(beforeSync, taskRef)?.status ?? 'unregistered';

    // Step 1: Update the markdown spec frontmatter to status: done
    const specs = discoverActiveTaskSpecs(BACKLOG_DOCS_DIR);
    const spec = specs.find((s) => s.ref === taskRef);
    if (!spec) {
      throw new Error(`Task spec not found in backlog/: ${taskRef}`);
    }
    if (spec.status !== 'done') {
      const specPath = join(BACKLOG_DOCS_DIR, spec.file);
      const content = readFileSync(specPath, 'utf8');
      const updated = content.replace(/^(status:\s*).+$/m, '$1done');
      if (updated === content) {
        throw new Error(`Could not locate status field in frontmatter of ${spec.file}`);
      }
      writeFileSync(specPath, updated, 'utf8');
    }

    // Step 2: Sync state from the (now-updated) spec
    syncBacklogFromSpecs(STATE_DIR, BACKLOG_DOCS_DIR, { lockAlreadyHeld: true });

    const synced = readBacklog(STATE_DIR);
    const task = findTask(synced, taskRef);
    if (!task) {
      throw new Error(`task not found after sync: ${taskRef}`);
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
  console.error((err as Error).message);
  process.exit(1);
}
