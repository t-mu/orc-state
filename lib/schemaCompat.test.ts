import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAllDatabases, initEventsDb } from './eventLog.ts';
import { readProcessStart } from './processIdentity.ts';
import { migrateProjectTaskSchema, PROJECT_TASK_SCHEMA, PROJECT_TASK_SCHEMA_VERSION, ProjectTaskStore } from './projectTaskStore.ts';
import { inspectRuntimeSchema, migrateRuntimeSchema, RUNTIME_SCHEMA, RUNTIME_SCHEMA_VERSION } from './runtimeSchema.ts';
import {
  assertMigrationAllowed, codeSupportsSchema, coordinatorSchemaProblems, inspectSchemaRange, liveCoordinatorSchemas,
  readSchemaRange, SchemaMigrationRefusedError, type SchemaSupport,
} from './schemaCompat.ts';

let dir: string;
let fake: ChildProcess | null = null;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orc-schema-compat-')); });
afterEach(() => {
  closeAllDatabases();
  fake?.kill('SIGKILL');
  fake = null;
  rmSync(dir, { recursive: true, force: true });
});

/** A live process running a script named coordinator.js, recorded in coordinator.pid with these schemas (none: a pre-range coordinator). */
async function startFakeCoordinator(schemas?: SchemaSupport): Promise<number> {
  const script = join(dir, 'coordinator.js');
  writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  fake = spawn(process.execPath, [script], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { fake!.once('spawn', resolve); fake!.once('error', reject); });
  const pid = fake.pid!;
  writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({
    pid, started_at: '2026-11-09T00:00:00.000Z', process_start: readProcessStart(pid), ...(schemas ? { schemas } : {}),
  }));
  return pid;
}

/** A runtime.db stopped at `version` (before schema ranges are recorded). */
function runtimeDbAt(version: number): void {
  const db = new Database(join(dir, 'runtime.db'));
  try { migrateProjectTaskSchema(db, version); } finally { db.close(); }
}

/** An events.db stopped at version 8, the last version before schema ranges. */
function eventsDbAtVersion8(): void {
  const db = new Database(join(dir, 'events.db'));
  try {
    // Block the version 9 migration, then remove the blocker: the database stays at 8.
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY CHECK (version < 9), name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    expect(() => migrateRuntimeSchema(db)).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(8);
    db.exec(`
      CREATE TABLE schema_migrations_plain (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations_plain SELECT version, name, applied_at FROM schema_migrations;
      DROP TABLE schema_migrations;
      ALTER TABLE schema_migrations_plain RENAME TO schema_migrations;
    `);
  } finally { db.close(); }
}

const userVersion = (file: string): number => {
  const db = new Database(join(dir, file), { readonly: true });
  try { return db.pragma('user_version', { simple: true }) as number; } finally { db.close(); }
};

const sqliteObjects = (file: string): string[] => {
  const db = new Database(join(dir, file), { readonly: true });
  try {
    return (db.prepare('SELECT type, name FROM sqlite_master ORDER BY type, name').all() as Array<{ type: string; name: string }>)
      .map((row) => `${row.type}:${row.name}`);
  } finally { db.close(); }
};

/** Pretend newer code moved the database to `version`, declaring `minCompatible` as the oldest code that can read it. */
function bumpTo(file: string, version: number, minCompatible: number): void {
  const db = new Database(join(dir, file));
  try {
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at, min_compatible) VALUES (?, 'future', 'now', ?)").run(version, minCompatible);
    db.pragma(`user_version = ${version}`);
  } finally { db.close(); }
}

describe('codeSupportsSchema', () => {
  it('covers older-or-equal schemas and newer ones that declare this code compatible', () => {
    expect(codeSupportsSchema(9, { version: 8, min_compatible: 8 })).toBe(true);
    expect(codeSupportsSchema(9, { version: 9, min_compatible: 9 })).toBe(true);
    expect(codeSupportsSchema(9, { version: 11, min_compatible: 9 })).toBe(true);
    expect(codeSupportsSchema(9, { version: 10, min_compatible: 10 })).toBe(false);
  });
});

describe('recorded schema range', () => {
  it('records min_compatible per version, and treats a database without it as readable only by its own version', () => {
    runtimeDbAt(5);
    expect(inspectSchemaRange(dir, 'runtime')).toEqual({ version: 5, min_compatible: 5 });
    new ProjectTaskStore(dir).close();
    expect(inspectSchemaRange(dir, 'runtime')).toEqual(PROJECT_TASK_SCHEMA);
    initEventsDb(dir);
    expect(inspectSchemaRange(dir, 'events')).toEqual(RUNTIME_SCHEMA);
    expect(inspectSchemaRange(join(dir, 'empty'), 'events')).toBeNull();
  });
});

describe('migration under a live coordinator', () => {
  it('refuses to migrate runtime.db while a coordinator that predates schema ranges is live, and leaves the database alone', async () => {
    runtimeDbAt(5);
    const pid = await startFakeCoordinator();
    expect(liveCoordinatorSchemas(dir)).toEqual({ pid, schemas: null });
    expect(() => new ProjectTaskStore(dir)).toThrow(SchemaMigrationRefusedError);
    expect(() => new ProjectTaskStore(dir)).toThrow(/runtime\.db needs migration from schema 5 to 6.*orc coordinator restart/);
    expect(userVersion('runtime.db')).toBe(5);
  });

  it('refuses to migrate events.db while an incompatible coordinator is live', async () => {
    eventsDbAtVersion8();
    await startFakeCoordinator({ events: { version: 8, min_compatible: 8 }, runtime: { version: 5, min_compatible: 5 } });
    const objects = sqliteObjects('events.db');
    expect(() => initEventsDb(dir)).toThrow(/events\.db needs migration from schema 8 to 9.*orc coordinator restart/);
    expect(userVersion('events.db')).toBe(8);
    // No table or index was created or dropped under the coordinator either.
    expect(sqliteObjects('events.db')).toEqual(objects);
  });

  it('migrates when the live coordinator can read the target schema, or when none runs', async () => {
    runtimeDbAt(5);
    eventsDbAtVersion8();
    await startFakeCoordinator({ events: { ...RUNTIME_SCHEMA }, runtime: { ...PROJECT_TASK_SCHEMA } });
    new ProjectTaskStore(dir).close();
    initEventsDb(dir);
    expect(userVersion('runtime.db')).toBe(PROJECT_TASK_SCHEMA_VERSION);
    expect(userVersion('events.db')).toBe(RUNTIME_SCHEMA_VERSION);

    fake!.kill('SIGKILL');
    await new Promise((resolve) => fake!.once('exit', resolve));
    expect(liveCoordinatorSchemas(dir)).toBeNull();
    expect(() => assertMigrationAllowed(dir, 'runtime', 1, { version: 99, min_compatible: 99 })).not.toThrow();
  });

  it('allows a migration whose target declares the live coordinator compatible', async () => {
    await startFakeCoordinator({ events: { version: 9, min_compatible: 9 }, runtime: { version: 6, min_compatible: 6 } });
    expect(() => assertMigrationAllowed(dir, 'runtime', 6, { version: 7, min_compatible: 6 })).not.toThrow();
    expect(() => assertMigrationAllowed(dir, 'runtime', 6, { version: 7, min_compatible: 7 })).toThrow(SchemaMigrationRefusedError);
    // A new database has no schema the coordinator depends on.
    expect(() => assertMigrationAllowed(dir, 'runtime', 0, { version: 7, min_compatible: 7 })).not.toThrow();
  });
});

describe('newer schema within the compatible range', () => {
  it('stays readable and writable by older code, and is refused beyond it', () => {
    new ProjectTaskStore(dir).close();
    initEventsDb(dir);
    closeAllDatabases();
    bumpTo('runtime.db', PROJECT_TASK_SCHEMA_VERSION + 1, PROJECT_TASK_SCHEMA_VERSION);
    bumpTo('events.db', RUNTIME_SCHEMA_VERSION + 1, RUNTIME_SCHEMA_VERSION);

    const store = new ProjectTaskStore(dir);
    try {
      store.createTask({ ref: 'feature/1', title: 'First', bodyMarkdown: '# First' });
      expect(store.getTask('feature/1')?.title).toBe('First');
    } finally { store.close(); }
    expect(() => initEventsDb(dir)).not.toThrow();
    expect(inspectRuntimeSchema(dir)).toMatchObject({ ok: true, version: RUNTIME_SCHEMA_VERSION + 1, min_compatible: RUNTIME_SCHEMA_VERSION });
    closeAllDatabases();
    // Nothing was downgraded or re-migrated.
    expect(userVersion('runtime.db')).toBe(PROJECT_TASK_SCHEMA_VERSION + 1);
    expect(userVersion('events.db')).toBe(RUNTIME_SCHEMA_VERSION + 1);

    bumpTo('runtime.db', PROJECT_TASK_SCHEMA_VERSION + 2, PROJECT_TASK_SCHEMA_VERSION + 2);
    bumpTo('events.db', RUNTIME_SCHEMA_VERSION + 2, RUNTIME_SCHEMA_VERSION + 1);
    expect(() => new ProjectTaskStore(dir)).toThrow(`needs code of schema ${PROJECT_TASK_SCHEMA_VERSION + 2} or newer`);
    expect(() => initEventsDb(dir)).toThrow(`needs code of schema ${RUNTIME_SCHEMA_VERSION + 1} or newer`);
    expect(inspectRuntimeSchema(dir)).toMatchObject({ ok: false, version: RUNTIME_SCHEMA_VERSION + 2 });
  });

  it('reads a recorded range from the database it is given', () => {
    const db = new Database(':memory:');
    try {
      migrateProjectTaskSchema(db);
      expect(readSchemaRange(db)).toEqual(PROJECT_TASK_SCHEMA);
    } finally { db.close(); }
  });
});

describe('coordinatorSchemaProblems', () => {
  const current = { events: RUNTIME_SCHEMA, runtime: PROJECT_TASK_SCHEMA };

  it('reports nothing when the coordinator covers each database', () => {
    expect(coordinatorSchemaProblems({ schema_version: RUNTIME_SCHEMA_VERSION, schemas: current }, current)).toEqual([]);
    expect(coordinatorSchemaProblems({ schema_version: RUNTIME_SCHEMA_VERSION, schemas: current }, { events: null, runtime: null })).toEqual([]);
  });

  it('flags each database the coordinator cannot read, falling back to schema_version for an older coordinator', () => {
    const old = { events: { version: 8, min_compatible: 8 }, runtime: { version: 5, min_compatible: 5 } };
    expect(coordinatorSchemaProblems({ schema_version: 8, schemas: old }, current)).toEqual([
      'running coordinator supports events.db schema 8, but the database is at schema 9 (needs code of schema 9 or newer); run orc coordinator restart',
      'running coordinator supports runtime.db schema 5, but the database is at schema 6 (needs code of schema 6 or newer); run orc coordinator restart',
    ]);
    expect(coordinatorSchemaProblems({ schema_version: 8 }, current)).toEqual([
      'running coordinator supports events.db schema 8, but the database is at schema 9 (needs code of schema 9 or newer); run orc coordinator restart',
    ]);
  });

  it('flags a pending migration the running coordinator blocks, and not one it can read', () => {
    const notMigrated = { events: { version: 8, min_compatible: 8 }, runtime: { version: 5, min_compatible: 5 } };
    expect(coordinatorSchemaProblems({ schema_version: 8 }, notMigrated, current)).toEqual([
      'events.db needs migration from schema 8 to 9, which the running coordinator (schema 8) cannot read, so orc refuses to migrate it; run orc coordinator restart',
      'runtime.db needs migration from schema 5 to 6, which the running coordinator (schema 5) cannot read, so orc refuses to migrate it; run orc coordinator restart',
    ]);
    expect(coordinatorSchemaProblems({ schema_version: 9, schemas: current }, notMigrated, current)).toEqual([]);
    expect(coordinatorSchemaProblems({ schema_version: 9, schemas: current }, current, current)).toEqual([]);
  });
});
