/**
 * e2e-real/harness/assertions.ts
 *
 * Reusable polling helpers and path-containment assertions for real-provider
 * smoke tests.
 *
 * Every wait uses an explicit stage-specific timeout so provider hangs produce
 * diagnosable failures instead of generic timeouts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { readBacklog } from '../../lib/stateReader.ts';
import { queryEvents } from '../../lib/eventLog.ts';
import type { TaskStatus } from '../../types/backlog.ts';
import type { OrcEvent } from '../../types/events.ts';

export interface WaitOptions {
  /** Poll interval (ms). Default: 500. */
  pollMs?: number;
  /** Stage label for diagnostics (e.g. "first_dispatch"). */
  stage: string;
  /** Timeout (ms). */
  timeoutMs: number;
}

/**
 * Poll until `predicate()` returns true, then resolve.
 * Rejects with a stage-specific message on timeout.
 */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  options: WaitOptions,
): Promise<void> {
  const { pollMs = 500, stage, timeoutMs } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error(`[assertions] timeout waiting for stage '${stage}' after ${timeoutMs}ms`);
}

// ── Task status polling ─────────────────────────────────────────────────────

/**
 * Wait for a task to reach the specified status.
 *
 * @param stateDir - Path to `.orc-state` in the temp repo.
 * @param taskRef  - Task ref string (e.g. `'smoke/task-1'`).
 * @param status   - Target status to wait for.
 * @param options  - Stage label and timeout.
 */
export async function waitForTaskStatus(
  stateDir: string,
  taskRef: string,
  status: TaskStatus,
  options: WaitOptions,
): Promise<void> {
  return waitUntil(() => {
    try {
      const backlog = readBacklog(stateDir);
      for (const feature of backlog.features) {
        const task = feature.tasks?.find((t) => t.ref === taskRef);
        if (task) return task.status === status;
      }
      return false;
    } catch {
      return false;
    }
  }, options);
}

// ── Run event polling ───────────────────────────────────────────────────────

/**
 * Wait for a specific lifecycle event for a run to appear in the event log.
 *
 * @param stateDir  - Path to `.orc-state` in the temp repo.
 * @param runId     - The run_id to match.
 * @param eventName - The `event` field to wait for (e.g. `'run_finished'`).
 * @param options   - Stage label and timeout.
 */
export async function waitForRunEvent(
  stateDir: string,
  runId: string,
  eventName: string,
  options: WaitOptions,
): Promise<OrcEvent> {
  let found: OrcEvent | undefined;
  await waitUntil(() => {
    try {
      // queryEvents filters by run_id at the DB level; we just match event name here
      const events = queryEvents(stateDir, { run_id: runId });
      found = events.find((e) => e.event === eventName);
      return found !== undefined;
    } catch {
      return false;
    }
  }, options);
  return found!;
}

// ── Worker reuse polling ────────────────────────────────────────────────────

/**
 * Wait for an agent to be reused for a second run (two `run_started` events
 * recorded for the same agent slot).
 *
 * @param stateDir - Path to `.orc-state` in the temp repo.
 * @param agentId  - Agent ID to watch (e.g. `'orc-1'`).
 * @param options  - Stage label and timeout.
 */
export async function waitForWorkerReuse(
  stateDir: string,
  agentId: string,
  options: WaitOptions,
): Promise<void> {
  return waitUntil(() => {
    try {
      // queryEvents filters by agent_id at the DB level; count run_started events for this agent
      const events = queryEvents(stateDir, { agent_id: agentId });
      const startCount = events.filter((e) => e.event === 'run_started').length;
      return startCount >= 2;
    } catch {
      return false;
    }
  }, options);
}

// ── Path containment assertions ─────────────────────────────────────────────

/**
 * Assert that all provided named paths are inside `repoRoot`.
 *
 * Throws with a descriptive message listing any escaped paths.
 */
export function assertPathsInside(repoRoot: string, paths: Record<string, string>): void {
  const resolvedRoot = resolve(repoRoot);
  const escaped: string[] = [];

  for (const [label, path] of Object.entries(paths)) {
    if (!path) continue;
    const resolved = resolve(path);
    const rel = relative(resolvedRoot, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      escaped.push(`${label}: ${resolved} (escapes ${resolvedRoot})`);
    }
  }

  if (escaped.length > 0) {
    throw new Error(
      `[assertions] paths escaped the temp repo root ${resolvedRoot}!\n` +
      escaped.map((e) => `  - ${e}`).join('\n'),
    );
  }
}

/**
 * Assert that all orchestrator-managed runtime paths are inside `repoRoot`.
 *
 * Checks the stateDir, worktreesDir, and any worktree paths listed in
 * `run-worktrees.json`. Throws with a descriptive message on violation.
 */
export function assertRuntimePathsInside(stateDir: string, repoRoot: string): void {
  const resolvedRoot = resolve(repoRoot);
  const escaped: string[] = [];

  function check(path: string, label: string): void {
    if (!path) return;
    const resolved = resolve(path);
    const rel = relative(resolvedRoot, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      escaped.push(`${label}: ${resolved} (escapes ${resolvedRoot})`);
    }
  }

  check(stateDir, 'stateDir');
  check(join(repoRoot, '.worktrees'), 'worktreesDir');

  // Check worktree paths from run-worktrees.json if it exists
  const runWorktreesPath = join(stateDir, 'run-worktrees.json');
  if (existsSync(runWorktreesPath)) {
    try {
      const data = JSON.parse(readFileSync(runWorktreesPath, 'utf8')) as {
        runs?: Array<{ worktree_path?: string; run_id?: string }>;
      };
      for (const entry of data.runs ?? []) {
        if (entry.worktree_path) {
          check(entry.worktree_path, `worktree[${entry.run_id ?? '?'}]`);
        }
      }
    } catch {
      // Non-fatal: file may not exist or be empty during startup
    }
  }

  if (escaped.length > 0) {
    throw new Error(
      `[assertions] orchestrator-managed paths escaped the temp repo root!\n` +
      escaped.map((e) => `  - ${e}`).join('\n'),
    );
  }
}
