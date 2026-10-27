import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { appendSequencedEvent, closeAllDatabases, initEventsDb, queryEvents } from './eventLog.ts';
import { closeMemoryDb, memoryWakeUp, storeDrawer } from './memoryStore.ts';
import { ControlClient } from './controlClient.ts';
import { readRunReviews, readViaCoordinator } from './projectReads.ts';
import { ProjectTaskStore } from './projectTaskStore.ts';
import { isReadOnlyOpenError, openReadOnlyDatabase, shouldOpenReadOnly } from './sqliteReadOnly.ts';

let dir: string;
const repoRoot = join(import.meta.dirname, '..');
const savedToken = process.env.ORC_SESSION_TOKEN;
// Root ignores file permissions, so a read-only state directory cannot be simulated.
const asRoot = process.getuid?.() === 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orc-readonly-test-'));
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.ORC_SESSION_TOKEN;
  else process.env.ORC_SESSION_TOKEN = savedToken;
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o600);
  closeMemoryDb();
  closeAllDatabases();
  rmSync(dir, { recursive: true, force: true });
});

/** The coordinator's state, written and closed; returns a writer that holds the WAL files open as the running coordinator does. */
function coordinatorState(): { holdOpen: () => () => void } {
  initEventsDb(dir);
  appendSequencedEvent(dir, {
    ts: new Date().toISOString(), event: 'review_submitted', actor_type: 'agent', actor_id: 'worker-a',
    run_id: 'run-a', agent_id: 'worker-a', payload: { outcome: 'approved', findings: 'ok' },
  });
  storeDrawer(dir, { wing: 'orch', hall: 'facts', room: 'build', content: 'remember the build', importance: 8 });
  const store = new ProjectTaskStore(dir);
  store.createTask({ ref: 'orch/task-a', title: 'Task A', bodyMarkdown: '# Task A' });
  store.close();
  closeMemoryDb();
  closeAllDatabases();
  return {
    holdOpen: () => {
      const held = ['events.db', 'memory.db', 'runtime.db'].map((name) => {
        const db = new Database(join(dir, name));
        db.prepare('SELECT 1').get();
        return db;
      });
      return () => { for (const db of held) db.close(); };
    },
  };
}

/** What a sandbox does: nothing in the state directory is writable. */
function lockStateDir(): void {
  for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o444);
  chmodSync(dir, 0o500);
}

describe('read-only opens (task 230)', () => {
  it('classifies only read-only and cannot-open failures, and only a session falls back', () => {
    const readOnly = Object.assign(new Error('x'), { code: 'SQLITE_READONLY_DIRECTORY' });
    expect(isReadOnlyOpenError(readOnly)).toBe(true);
    expect(isReadOnlyOpenError(Object.assign(new Error('x'), { code: 'SQLITE_CANTOPEN' }))).toBe(true);
    expect(isReadOnlyOpenError(Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT' }))).toBe(false);
    expect(isReadOnlyOpenError(new Error('x'))).toBe(false);
    const path = join(dir, 'x.db');
    new Database(path).close();
    expect(shouldOpenReadOnly(readOnly, path, { ORC_SESSION_TOKEN: 'session-a' })).toBe(true);
    // The coordinator, the MCP server and operator shells write: they fail loudly instead.
    expect(shouldOpenReadOnly(readOnly, path, {})).toBe(false);
    expect(shouldOpenReadOnly(readOnly, join(dir, 'missing.db'), { ORC_SESSION_TOKEN: 'session-a' })).toBe(false);
  });
});

describe.skipIf(asRoot)('state stores without write access to the state directory (task 230)', () => {
  it('a session reads events, memories and tasks while the coordinator holds them open', () => {
    const release = coordinatorState().holdOpen();
    lockStateDir();
    process.env.ORC_SESSION_TOKEN = 'session-a';
    try {
      expect(queryEvents(dir, { run_id: 'run-a', event_type: 'review_submitted' })).toHaveLength(1);
      expect(memoryWakeUp(dir)).toContain('remember the build');
      const reader = new ProjectTaskStore(dir);
      expect(reader.getTask('orch/task-a')?.title).toBe('Task A');
      reader.close();
    } finally {
      release();
    }
  });

  it('with the coordinator stopped the read is refused as retryable, not as a readonly write', () => {
    coordinatorState();
    lockStateDir();
    process.env.ORC_SESSION_TOKEN = 'session-a';
    expect(() => queryEvents(dir, { run_id: 'run-a' })).toThrow(/cannot be read without write access while no coordinator holds it open; retry/);
    expect(() => openReadOnlyDatabase(join(dir, 'memory.db'))).toThrow(/retry once the coordinator is running/);
  });

  it('a process without a session keeps its own open error and caches nothing', () => {
    const state = coordinatorState();
    lockStateDir();
    delete process.env.ORC_SESSION_TOKEN;
    // A writer (coordinator, MCP server, operator shell) sees SQLite's error, not a read-only fallback.
    expect(() => queryEvents(dir, { run_id: 'run-a' })).toThrow('attempt to write a readonly database');
    process.env.ORC_SESSION_TOKEN = 'session-a';
    expect(() => queryEvents(dir, { run_id: 'run-a' })).toThrow(/retry once the coordinator is running/);
    // Once the coordinator holds the files open again, the same process reads them.
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o600);
    const release = state.holdOpen();
    lockStateDir();
    try {
      expect(queryEvents(dir, { run_id: 'run-a', event_type: 'review_submitted' })).toHaveLength(1);
    } finally {
      release();
    }
  });

  it('a project read falls back to the state directory when no coordinator answers', async () => {
    const release = coordinatorState().holdOpen();
    lockStateDir();
    process.env.ORC_SESSION_TOKEN = 'session-a';
    try {
      // No control.json: the client reports the coordinator unavailable, and the read goes direct.
      const reviews = await readViaCoordinator(
        async (client) => (await client.reviews('run-a')).reviews,
        () => readRunReviews(dir, 'run-a'),
        { project: 'p', client: () => new ControlClient(dir) },
      );
      expect(reviews.map((review) => review.payload.findings)).toEqual(['ok']);
    } finally {
      release();
    }
  });

  it('the worker read commands print their results from a read-only state directory', () => {
    const release = coordinatorState().holdOpen();
    lockStateDir();
    const run = (...args: string[]) => spawnSync(process.execPath, ['cli/orc.ts', ...args], {
      cwd: repoRoot, encoding: 'utf8',
      env: { ...process.env, ORC_STATE_DIR: dir, ORC_REPO_ROOT: dir, ORC_SESSION_TOKEN: 'session-a' },
    });
    try {
      const reviews = run('review-read', '--run-id=run-a', '--json');
      expect(reviews.status, reviews.stderr).toBe(0);
      expect(JSON.parse(reviews.stdout)).toMatchObject({ count: 1 });
      const memories = run('memory-wake-up');
      expect(memories.status, memories.stderr).toBe(0);
      expect(memories.stdout).toContain('remember the build');
      for (const command of [['status'], ['runs-active'], ['run-info', 'run-x']]) {
        expect(run(...command).stderr).not.toContain('readonly database');
      }
    } finally {
      release();
    }
  }, 30_000);
});
