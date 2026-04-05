/**
 * e2e-real/fixtures/blessedTasks.ts
 *
 * Static blessed-path backlog task specs for real-provider smoke tests.
 *
 * These two tasks are designed for sequential dispatch in a temp repo:
 *   - Task 1 completes first (writes a marker file to confirm worker ran)
 *   - Task 2 runs after task 1 is done (depends_on task 1)
 *
 * Assertions remain lifecycle/event/path based, not byte-stable provider
 * output based. The tasks instruct workers to touch a marker file so the test
 * can confirm work was actually dispatched without relying on provider output.
 *
 * Both tasks are deterministic and do not require network access beyond
 * what the provider CLI itself needs for auth.
 */

export interface BlessedTask {
  ref: string;
  title: string;
  markerId: string;
}

/**
 * First task: creates a marker file to confirm the worker session ran.
 */
export const BLESSED_TASK_1: BlessedTask = {
  ref: 'smoke/task-1',
  title: 'Smoke task 1: create marker file',
  markerId: 'smoke-marker-1.txt',
};

/**
 * Second task: runs after task 1, creates a second marker file.
 * Depends on task 1 to verify sequential dispatch.
 */
export const BLESSED_TASK_2: BlessedTask = {
  ref: 'smoke/task-2',
  title: 'Smoke task 2: create marker file (sequential)',
  markerId: 'smoke-marker-2.txt',
};

/**
 * Build the backlog task entry for task 1.
 * The markdown spec instructs the worker to touch the marker file, then
 * immediately call the required lifecycle commands and exit.
 */
export function blessedTask1BacklogEntry(): Record<string, unknown> {
  return {
    ref: BLESSED_TASK_1.ref,
    title: BLESSED_TASK_1.title,
    status: 'todo',
    planning_state: 'ready_for_dispatch',
    task_type: 'implementation',
  };
}

/**
 * Build the backlog task entry for task 2.
 */
export function blessedTask2BacklogEntry(): Record<string, unknown> {
  return {
    ref: BLESSED_TASK_2.ref,
    title: BLESSED_TASK_2.title,
    status: 'todo',
    planning_state: 'ready_for_dispatch',
    task_type: 'implementation',
    depends_on: [BLESSED_TASK_1.ref],
  };
}

/**
 * Minimal markdown spec content for a blessed smoke task.
 *
 * The spec instructs the worker to:
 *   1. Call run-start
 *   2. Touch the marker file under the repo root
 *   3. Call task-mark-done
 *   4. Call run-work-complete
 *   5. Call run-finish
 *
 * This is the minimal blessed path without reviews or rebases.
 */
export function buildBlessedTaskSpec(task: BlessedTask, repoRoot: string): string {
  return [
    `---`,
    `ref: ${task.ref}`,
    `feature: smoke`,
    `priority: normal`,
    `status: todo`,
    `---`,
    ``,
    `# ${task.title}`,
    ``,
    `## Objective`,
    ``,
    `Touch the file \`${task.markerId}\` at the repo root to confirm this worker session ran.`,
    ``,
    `## Implementation`,
    ``,
    `1. Call \`orc run-start\` with your run_id and agent_id from the TASK_START payload.`,
    `2. Create the file \`${repoRoot}/${task.markerId}\` with content "done".`,
    `3. Call \`orc task-mark-done ${task.ref}\`.`,
    `4. Call \`orc run-work-complete\` with your run_id and agent_id.`,
    `5. Call \`orc run-finish\` with your run_id and agent_id.`,
    ``,
    `Do not do anything else. This is a minimal smoke verification task.`,
  ].join('\n');
}
