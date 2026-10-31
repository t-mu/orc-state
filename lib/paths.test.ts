import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

describe('paths', () => {
  beforeEach(() => {
    vi.resetModules();
    // An ambient ORC_STATE_DIR is present inside orc worker sessions; clear it.
    vi.stubEnv('ORC_STATE_DIR', undefined as unknown as string);
    vi.stubEnv('ORC_WORKTREES_DIR', undefined as unknown as string);
    vi.stubEnv('ORC_DATA_HOME', '/tmp/orc-paths-test-data-home');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('without a project, points STATE_DIR at an unowned placeholder in the data home, never the cwd repository', async () => {
    const { ACTIVE_PROJECT, STATE_DIR, EVENTS_FILE, RUN_WORKTREES_FILE, WORKTREES_DIR, TARGET_REPO_ROOT } = await import('./paths.ts');
    expect(ACTIVE_PROJECT).toBeNull();
    expect(STATE_DIR).toBe('/tmp/orc-paths-test-data-home/no-project');
    expect(EVENTS_FILE).toBe('/tmp/orc-paths-test-data-home/no-project/events.db');
    expect(RUN_WORKTREES_FILE).toBe('/tmp/orc-paths-test-data-home/no-project/run-worktrees.json');
    expect(WORKTREES_DIR).toBe('/tmp/orc-paths-test-data-home/no-project/worktrees');
    expect(TARGET_REPO_ROOT).toBe(process.cwd());
  });

  it('refuses to run without a registered project', async () => {
    const { assertProjectMode } = await import('./paths.ts');
    expect(() => assertProjectMode()).toThrow(/No registered project here.*orc project add.*--project.*orc project select/);
  });

  it('honors an explicit ORC_STATE_DIR and keeps run worktrees inside it', async () => {
    vi.stubEnv('ORC_STATE_DIR', '/tmp/override-state');
    const { STATE_DIR, WORKTREES_DIR } = await import('./paths.ts');
    expect(STATE_DIR).toBe('/tmp/override-state');
    expect(WORKTREES_DIR).toBe('/tmp/override-state/worktrees');
  });

  it('hookEventPath returns per-agent ndjson file under pty-hook-events', async () => {
    vi.stubEnv('ORC_STATE_DIR', '/tmp/state');
    const { hookEventPath } = await import('./paths.ts');
    expect(hookEventPath('agent-1')).toBe('/tmp/state/pty-hook-events/agent-1.ndjson');
    expect(hookEventPath('scout-3')).toBe('/tmp/state/pty-hook-events/scout-3.ndjson');
  });
});

describe('consumeHookEvents', () => {
  let stateDir: string;

  beforeEach(() => {
    vi.resetModules();
    stateDir = createTempStateDir('hook-events-test-');
    vi.stubEnv('ORC_STATE_DIR', stateDir);
    mkdirSync(join(stateDir, 'pty-hook-events'), { recursive: true });
  });

  afterEach(() => {
    cleanupTempStateDir(stateDir);
    vi.unstubAllEnvs();
  });

  it('returns empty array when no hook events file exists', async () => {
    const { consumeHookEvents } = await import('./paths.ts');
    expect(consumeHookEvents('agent-1')).toEqual([]);
  });

  it('returns parsed events and removes the file atomically', async () => {
    const { consumeHookEvents, hookEventPath } = await import('./paths.ts');
    const file = hookEventPath('agent-1');
    writeFileSync(file, JSON.stringify({ type: 'permission', message: 'Allow bash?', ts: '2026-01-01T00:00:00Z' }) + '\n');

    const events = consumeHookEvents('agent-1');
    expect(events).toEqual([{ type: 'permission', message: 'Allow bash?', ts: '2026-01-01T00:00:00Z' }]);
    // Both source and .processing files should be gone
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.processing`)).toBe(false);
  });

  it('does not lose events appended concurrently during consume', async () => {
    // Simulates: hook appends event A, coordinator starts consuming (rename),
    // hook appends event B to a new file (since original was renamed).
    // Both events should be recoverable — A from the current consume, B from the next.
    const { consumeHookEvents, hookEventPath } = await import('./paths.ts');
    const file = hookEventPath('agent-1');
    writeFileSync(file, JSON.stringify({ type: 'permission', message: 'event-A', ts: '' }) + '\n');

    // Consume event A (rename + read + delete)
    const eventsA = consumeHookEvents('agent-1');
    expect(eventsA).toHaveLength(1);
    expect(eventsA[0].message).toBe('event-A');

    // Meanwhile, the hook writer creates a NEW file (the old one was renamed away)
    appendFileSync(file, JSON.stringify({ type: 'permission', message: 'event-B', ts: '' }) + '\n');

    // Next consume picks up event B
    const eventsB = consumeHookEvents('agent-1');
    expect(eventsB).toHaveLength(1);
    expect(eventsB[0].message).toBe('event-B');
  });

  it('skips malformed NDJSON lines without losing valid ones', async () => {
    const { consumeHookEvents, hookEventPath } = await import('./paths.ts');
    const file = hookEventPath('agent-1');
    writeFileSync(file,
      'NOT-VALID-JSON\n' +
      JSON.stringify({ type: 'permission', message: 'valid event', ts: '' }) + '\n',
    );

    const events = consumeHookEvents('agent-1');
    expect(events).toEqual([{ type: 'permission', message: 'valid event', ts: '' }]);
  });
});
