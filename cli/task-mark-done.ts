#!/usr/bin/env node
/**
 * cli/task-mark-done.ts
 * Usage: orc task-mark-done <task_ref> [--actor-id=<id>]
 *
 * Runtime-only task completion. The coordinator uses this after a successful
 * merge to mark the shared backlog state done. Workers are responsible for
 * updating task markdown frontmatter inside their assigned worktree branch.
 */
import { flag } from '../lib/args.ts';
import { markTaskDoneRuntimeOnly, writeSpecStatusDone } from '../lib/taskCompletion.ts';
import { cliError } from './shared.ts';

const taskRef = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
const actorId = flag('actor-id') ?? 'human';

if (!taskRef) {
  console.error('Usage: orc task-mark-done <task_ref> [--actor-id=<id>]');
  process.exit(1);
}

try {
  markTaskDoneRuntimeOnly(taskRef, actorId);
  // Sibling-mode only: also mirror `done` into the orchestration spec file
  // (no-op in the attached layout). Best-effort — never fails the command.
  writeSpecStatusDone(taskRef);
} catch (err) {
  cliError(err);
}
