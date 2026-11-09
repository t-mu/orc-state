import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CONTROL_ENDPOINT_FILE } from './controlProtocol.ts';
import { findLiveCoordinator } from './coordinatorLiveness.ts';

/**
 * A schema version and the oldest code that can still read and write it,
 * named by the schema version that code was built for. Code built for
 * schema C opens a database at version V when V <= C (migrating it up) or
 * when the database records `min_compatible <= C`.
 */
export interface SchemaRange { version: number; min_compatible: number }

/** The two project databases whose schemas a coordinator depends on. */
export interface SchemaSupport { events: SchemaRange; runtime: SchemaRange }
export type SchemaDatabase = keyof SchemaSupport;

const DB_FILES: Record<SchemaDatabase, string> = { events: 'events.db', runtime: 'runtime.db' };

/** True when code built for schema `codeVersion` can read and write a database at `db`. */
export function codeSupportsSchema(codeVersion: number, db: SchemaRange): boolean {
  return db.version <= codeVersion || db.min_compatible <= codeVersion;
}

/**
 * The database's recorded range: `min_compatible` of its current version's
 * `schema_migrations` row. A database migrated before the column existed
 * (or with no row for its version) is readable only by code of its own version.
 */
export function readSchemaRange(db: Database.Database): SchemaRange {
  const version = db.pragma('user_version', { simple: true }) as number;
  try {
    const columns = db.prepare('PRAGMA table_info(schema_migrations)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'min_compatible')) return { version, min_compatible: version };
    const row = db.prepare('SELECT min_compatible FROM schema_migrations WHERE version = ?').get(version) as { min_compatible: number | null } | undefined;
    return { version, min_compatible: typeof row?.min_compatible === 'number' ? row.min_compatible : version };
  } catch {
    return { version, min_compatible: version };
  }
}

/** The recorded range of a project database, opened read-only; null when the file is missing or unreadable. */
export function inspectSchemaRange(stateDir: string, database: SchemaDatabase): SchemaRange | null {
  const path = join(stateDir, DB_FILES[database]);
  if (!existsSync(path)) return null;
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return readSchemaRange(db);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function readSchemas(path: string, pid: number): SchemaSupport | null {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; schemas?: SchemaSupport };
    return record.pid === pid && record.schemas ? record.schemas : null;
  } catch {
    return null;
  }
}

/**
 * The live coordinator for this state directory (other than this process)
 * and the schemas its pid lock or control endpoint says it supports; `schemas`
 * is null for a coordinator that predates schema ranges.
 */
export function liveCoordinatorSchemas(stateDir: string): { pid: number; schemas: SchemaSupport | null } | null {
  const live = findLiveCoordinator(stateDir);
  if (!live || live.pid === process.pid) return null;
  const schemas = readSchemas(join(stateDir, 'coordinator.pid'), live.pid) ?? readSchemas(join(stateDir, CONTROL_ENDPOINT_FILE), live.pid);
  return { pid: live.pid, schemas };
}

export class SchemaMigrationRefusedError extends Error {
  readonly code = 'schema_migration_refused';
}

/**
 * Refuse to migrate a database from `fromVersion` to `target` while a live
 * coordinator runs code that cannot read `target`. A coordinator that
 * records no schemas predates ranges and is taken to support only the
 * database's current version. A new database (version 0) is created freely:
 * no running coordinator depends on its schema.
 */
export function assertMigrationAllowed(stateDir: string, database: SchemaDatabase, fromVersion: number, target: SchemaRange): void {
  if (fromVersion === 0 || fromVersion >= target.version) return;
  const live = liveCoordinatorSchemas(stateDir);
  if (!live) return;
  const supported = live.schemas?.[database]?.version ?? fromVersion;
  if (codeSupportsSchema(supported, target)) return;
  throw new SchemaMigrationRefusedError(
    `${DB_FILES[database]} needs migration from schema ${fromVersion} to ${target.version}, but the running coordinator (PID ${live.pid}) `
    + `supports schema ${supported} and schema ${target.version} needs code of schema ${target.min_compatible} or newer. `
    + 'Run `orc coordinator restart` (or `orc start-session`) so the new coordinator migrates it.',
  );
}

/**
 * Problems for `orc doctor`: each database the running coordinator's
 * schema support does not cover. `coordinator` is what its `/v1/health`
 * reported (`schemas`, or only `schema_version` from an older coordinator).
 */
export function coordinatorSchemaProblems(
  coordinator: { schemas?: Partial<SchemaSupport>; schema_version?: number },
  databases: Partial<Record<SchemaDatabase, SchemaRange | null>>,
): string[] {
  const problems: string[] = [];
  for (const database of Object.keys(DB_FILES) as SchemaDatabase[]) {
    const db = databases[database];
    const supported = coordinator.schemas?.[database]?.version ?? (database === 'events' ? coordinator.schema_version : undefined);
    if (!db || typeof supported !== 'number' || codeSupportsSchema(supported, db)) continue;
    problems.push(`running coordinator supports ${DB_FILES[database]} schema ${supported}, but the database is at schema ${db.version} `
      + `(needs code of schema ${db.min_compatible} or newer); run orc coordinator restart`);
  }
  return problems;
}
