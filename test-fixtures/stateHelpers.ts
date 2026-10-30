import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { discoverActiveTaskSpecs, syncBacklogFromSpecsLoaded, type SyncResult } from '../lib/backlogSync.ts';
import type { Backlog } from '../types/backlog.ts';

export function createTempStateDir(prefix = 'orch-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export const TEST_PROJECT_ID = 'test-project';

/**
 * Marks a temp state directory as a registered project's (its project.json descriptor) and returns
 * the environment that selects it without a registry. Entry points refuse to run anything else.
 */
export function bridgeProjectEnv(dir: string, targetRepoRoot: string = dir): { ORC_PROJECT_ID: string; ORC_STATE_DIR: string } {
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify({ id: TEST_PROJECT_ID, name: 'test', target_repo_root: targetRepoRoot }, null, 2)}\n`);
  return { ORC_PROJECT_ID: TEST_PROJECT_ID, ORC_STATE_DIR: dir };
}

export function cleanupTempStateDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Writes a minimal valid state directory: backlog.json (one 'orch' feature),
 * agents.json, claims.json, and an empty events.jsonl.
 */
export function seedState(
  dir: string,
  options: { tasks?: unknown[]; claims?: unknown[]; agents?: unknown[] } = {}
): void {
  const { tasks = [], claims = [], agents = [] } = options;
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: tasks.length > 0 ? [{ ref: 'orch', title: 'Orch', tasks }] : [],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

export function readStateFile<T = unknown>(dir: string, filename: string): T {
  return JSON.parse(readFileSync(join(dir, filename), 'utf8')) as T;
}

// ---------------------------------------------------------------------------
// State assertion helpers for coordinator tests
// ---------------------------------------------------------------------------

export function readAgents(dir: string): Array<Record<string, unknown>> {
  return readStateFile<{ agents: Array<Record<string, unknown>> }>(dir, 'agents.json').agents;
}

export function readClaims(dir: string): Array<Record<string, unknown>> {
  return readStateFile<{ claims: Array<Record<string, unknown>> }>(dir, 'claims.json').claims;
}

export function readBacklog(dir: string): { features: Array<{ ref?: string; tasks: Array<Record<string, unknown>> }> } {
  return readStateFile<{ features: Array<{ ref?: string; tasks: Array<Record<string, unknown>> }> }>(dir, 'backlog.json');
}

// ---------------------------------------------------------------------------
// Mock factories for coordinator tests
// ---------------------------------------------------------------------------

/**
 * Returns a mock module object for './adapters/index.ts'.
 * Pass overrides to replace specific adapter methods; all others get sensible defaults.
 *
 * Usage:
 *   vi.doMock('./adapters/index.ts', () => makeAdapterMock({ start: mockStart, send: mockSend }));
 */
export function makeAdapterMock(overrides: Record<string, unknown> = {}): { createAdapter: () => Record<string, unknown> } {
  return {
    createAdapter: () => ({
      heartbeatProbe: vi.fn().mockResolvedValue(true),
      start: vi.fn().mockResolvedValue({ session_handle: 'pty:default', provider_ref: null }),
      send: vi.fn().mockResolvedValue(''),
      stop: vi.fn().mockResolvedValue(undefined),
      attach: vi.fn().mockResolvedValue(''),
      getOutputTail: vi.fn().mockReturnValue(null),
      ...overrides,
    }),
  };
}

/**
 * Returns a mock module object for './lib/runWorktree.ts'.
 * Pass overrides to replace specific functions.
 *
 * Usage:
 *   vi.doMock('./lib/runWorktree.ts', () => makeRunWorktreeMock());
 *   vi.doMock('./lib/runWorktree.ts', () => makeRunWorktreeMock({
 *     getRunWorktree: vi.fn().mockReturnValue({ branch: 'task/foo', worktree_path: '/tmp/foo' }),
 *   }));
 */
export function makeRunWorktreeMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ensureRunWorktree: vi.fn().mockReturnValue({
      run_id: 'run-allocated',
      branch: 'task/run-allocated',
      worktree_path: '/tmp/orc-worktrees/run-allocated',
    }),
    cleanupRunWorktree: vi.fn().mockReturnValue(true),
    deleteRunWorktree: vi.fn().mockReturnValue(true),
    pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
    getRunWorktree: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

/** Registers backlog/ Markdown specs into a legacy fixture's backlog.json, as migration reads them. */
export function seedBacklogFromSpecs(stateDir: string, docsDir: string): SyncResult {
  const backlogPath = join(stateDir, 'backlog.json');
  const backlog = JSON.parse(readFileSync(backlogPath, 'utf8')) as Backlog;
  const result = syncBacklogFromSpecsLoaded(backlog, discoverActiveTaskSpecs(docsDir));
  if (result.updated) writeFileSync(backlogPath, JSON.stringify(backlog));
  return result;
}
