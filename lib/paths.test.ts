import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

describe('paths', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('./repoRoot.ts');
  });

  it('defaults STATE_DIR to the canonical repo root instead of the ambient cwd', async () => {
    vi.doMock('./repoRoot.ts', () => ({
      resolveRepoRoot: vi.fn().mockReturnValue('/tmp/repo-root'),
    }));

    const { STATE_DIR, EVENTS_FILE, ORCHESTRATOR_CONFIG_FILE, RUN_WORKTREES_FILE } = await import('./paths.ts');
    expect(STATE_DIR).toBe('/tmp/repo-root/.orc-state');
    expect(EVENTS_FILE).toBe('/tmp/repo-root/.orc-state/events.db');
    expect(ORCHESTRATOR_CONFIG_FILE).toBe('/tmp/repo-root/orc-state.config.json');
    expect(RUN_WORKTREES_FILE).toBe('/tmp/repo-root/.orc-state/run-worktrees.json');
  });

  it('still honors ORC_STATE_DIR overrides explicitly', async () => {
    vi.stubEnv('ORC_STATE_DIR', '/tmp/override-state');
    const { STATE_DIR } = await import('./paths.ts');
    expect(STATE_DIR).toBe('/tmp/override-state');
  });

  it('hookEventPath returns per-agent ndjson file under pty-hook-events', async () => {
    vi.doMock('./repoRoot.ts', () => ({
      resolveRepoRoot: vi.fn().mockReturnValue('/tmp/repo-root'),
    }));

    const { hookEventPath } = await import('./paths.ts');
    expect(hookEventPath('agent-1')).toBe('/tmp/repo-root/.orc-state/pty-hook-events/agent-1.ndjson');
    expect(hookEventPath('scout-3')).toBe('/tmp/repo-root/.orc-state/pty-hook-events/scout-3.ndjson');
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
