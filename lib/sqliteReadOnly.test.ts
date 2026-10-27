import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { appendSequencedEvent, closeAllDatabases, initEventsDb, queryEvents } from './eventLog.ts';
import { closeMemoryDb, memoryWakeUp, storeDrawer } from './memoryStore.ts';
import { ProjectTaskStore } from './projectTaskStore.ts';
import { isReadOnlyOpenError, openReadOnlyDatabase } from './sqliteReadOnly.ts';

let dir: string;
// Root ignores directory permissions, so a read-only directory cannot be simulated.
const asRoot = process.getuid?.() === 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orc-readonly-test-'));
});

afterEach(() => {
  chmodSync(dir, 0o700);
  closeMemoryDb();
  closeAllDatabases();
  rmSync(dir, { recursive: true, force: true });
});

/** A WAL database closed cleanly, so no -wal/-shm files remain for a reader to use. */
function walDatabase(path: string, rows: number[]): void {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (n INTEGER)');
  for (const n of rows) db.prepare('INSERT INTO t VALUES (?)').run(n);
  db.close();
}

describe.skipIf(asRoot)('openReadOnlyDatabase (task 230)', () => {
  it('reads a WAL database in a directory it cannot write, with no WAL files left', () => {
    const path = join(dir, 'x.db');
    walDatabase(path, [1, 2]);
    chmodSync(dir, 0o500);
    expect(() => new Database(path, { readonly: true }).prepare('SELECT 1 FROM t').get()).toThrow();
    const db = openReadOnlyDatabase(path);
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 2 });
    expect(() => db.prepare('INSERT INTO t VALUES (3)').run()).toThrow();
    db.close();
    expect(readdirSync(dir)).toEqual(['x.db']);
  });

  it('reads uncheckpointed WAL content a live writer holds open', () => {
    const path = join(dir, 'x.db');
    walDatabase(path, [1]);
    const writer = new Database(path);
    writer.pragma('wal_autocheckpoint = 0');
    writer.prepare('INSERT INTO t VALUES (2)').run();
    chmodSync(dir, 0o500);
    const reader = openReadOnlyDatabase(path);
    expect(reader.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 2 });
    reader.close();
    writer.close();
  });

  it('classifies only read-only and cannot-open failures as read-only', () => {
    expect(isReadOnlyOpenError(Object.assign(new Error('x'), { code: 'SQLITE_READONLY_DIRECTORY' }))).toBe(true);
    expect(isReadOnlyOpenError(Object.assign(new Error('x'), { code: 'SQLITE_CANTOPEN' }))).toBe(true);
    expect(isReadOnlyOpenError(Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT' }))).toBe(false);
    expect(isReadOnlyOpenError(new Error('x'))).toBe(false);
    expect(() => openReadOnlyDatabase(join(dir, 'missing.db'))).toThrow();
  });
});

describe.skipIf(asRoot)('state stores without write access to the state directory (task 230)', () => {
  it('events, memories and project tasks stay readable once the coordinator closed them', () => {
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
    // A clean close removes the WAL files a read-only open would otherwise need.
    expect(existsSync(join(dir, 'events.db-shm'))).toBe(false);
    chmodSync(dir, 0o500);

    expect(queryEvents(dir, { run_id: 'run-a', event_type: 'review_submitted' })).toHaveLength(1);
    expect(memoryWakeUp(dir)).toContain('remember the build');
    const reader = new ProjectTaskStore(dir);
    expect(reader.getTask('orch/task-a')?.title).toBe('Task A');
    reader.close();
  });

  it('still refuses to create a missing database it cannot write', () => {
    chmodSync(dir, 0o500);
    expect(() => initEventsDb(dir)).toThrow();
  });
});
