/**
 * e2e-real/fixtures/blessedTasks.ts
 *
 * Static blessed-path backlog task specs for real-provider smoke tests.
 *
 * These two tasks are designed for sequential dispatch in a temp repo:
 *   - Task 1 completes first (creates a module + test)
 *   - Task 2 runs after task 1 is done (depends_on task 1)
 *
 * Each task is trivially implementable — the point is to exercise the full
 * worker lifecycle (explore → implement → review → complete → finalize),
 * not to challenge the LLM's coding ability.
 *
 * Both tasks use Node's built-in test runner (node:test) so no npm install
 * is needed in the temp repo.
 */

export interface BlessedTask {
  ref: string;
  title: string;
  /** Source file the worker should create — used as an existence check. */
  sourceFile: string;
  /** Numbered backlog markdown filename used by active spec discovery. */
  specFile: string;
}

/**
 * First task: creates a module + test.
 */
export const BLESSED_TASK_1: BlessedTask = {
  ref: 'smoke/task-1',
  title: 'Smoke task 1: create marker-1 module',
  sourceFile: 'lib/marker-1.mjs',
  specFile: '101-smoke-task-1.md',
};

/**
 * Second task: runs after task 1, creates a second module + test.
 * Depends on task 1 to verify sequential dispatch.
 */
export const BLESSED_TASK_2: BlessedTask = {
  ref: 'smoke/task-2',
  title: 'Smoke task 2: create marker-2 module',
  sourceFile: 'lib/marker-2.mjs',
  specFile: '102-smoke-task-2.md',
};

/**
 * Build the backlog task entry for task 1.
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
 * Build a markdown task spec for a blessed smoke task.
 *
 * The spec describes a trivially implementable task (create a module that
 * exports a marker value, plus a test using node:test). The worker follows
 * the full phased workflow from the bootstrap template — including npm test,
 * git commit, sub-agent reviews, rebase, and all lifecycle commands.
 */
export function buildBlessedTaskSpec(task: BlessedTask, _repoRoot: string): string {
  const num = task.ref.endsWith('task-1') ? '1' : '2';
  return [
    '---',
    `ref: ${task.ref}`,
    'feature: smoke',
    'priority: normal',
    'status: todo',
    '---',
    '',
    `# ${task.title}`,
    '',
    '## Objective',
    '',
    'Create a marker module and its test to confirm this worker session ran successfully.',
    '',
    '## Implementation',
    '',
    `1. Create \`lib/marker-${num}.mjs\` with exactly this content:`,
    '   ```js',
    `   export const MARKER_${num} = 'task-${num}-done';`,
    '   ```',
    `2. Create \`lib/marker-${num}.test.mjs\` with a test that imports \`MARKER_${num}\``,
    `   from \`./marker-${num}.mjs\` and asserts it equals \`'task-${num}-done'\`.`,
    "   Use `node:test` and `node:assert/strict` (the project uses Node's built-in test runner).",
    '3. Run `npm test` to verify all tests pass.',
    '',
    '## Acceptance Criteria',
    '',
    `- [ ] \`lib/marker-${num}.mjs\` exists and exports MARKER_${num}`,
    `- [ ] \`lib/marker-${num}.test.mjs\` exists and passes`,
    '- [ ] `npm test` passes with no new failures',
    '',
    '## Notes',
    '',
    'This is a minimal smoke task. Do not add anything beyond what is specified above.',
  ].join('\n');
}
