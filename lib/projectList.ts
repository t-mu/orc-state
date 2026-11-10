import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findLiveCoordinator } from './coordinatorLiveness.ts';
import { CONTROL_ENDPOINT_FILE, type ControlEndpoint } from './controlProtocol.ts';
import { projectDataHome } from './dataHome.ts';
import type { ProjectRecord } from './projectRegistry.ts';

// Built-ins only: this module is part of the client entry (`orc-state/client`),
// so it reads registry.db with node:sqlite instead of better-sqlite3.

/** The newest registry.db schema (`user_version`) this module can read. */
export const SUPPORTED_REGISTRY_SCHEMA_VERSION = 1;

/** registry.db was written by a newer orc whose schema this client cannot read. */
export class RegistrySchemaError extends Error {
  readonly version: number;
  readonly supportedVersion = SUPPORTED_REGISTRY_SCHEMA_VERSION;
  constructor(version: number) {
    super(`registry.db schema version ${version} is newer than supported version ${SUPPORTED_REGISTRY_SCHEMA_VERSION}`);
    this.name = 'RegistrySchemaError';
    this.version = version;
  }
}

/** One registered project, with what a client needs to open its control connection. */
export interface ProjectListEntry {
  id: string;
  name: string;
  target_repo_root: string;
  state_dir: string;
  /** Whether `target_repo_root` still exists on disk (a moved or deleted checkout stays registered). */
  repo_present: boolean;
  /** Unix socket from the project's `control.json`; null unless the coordinator is running (a stopped coordinator leaves a stale file) or the file is missing or unreadable. */
  control_socket: string | null;
  coordinator_running: boolean;
}

function controlSocket(stateDir: string): string | null {
  try {
    const endpoint = JSON.parse(readFileSync(join(stateDir, CONTROL_ENDPOINT_FILE), 'utf8')) as Partial<ControlEndpoint>;
    return typeof endpoint.path === 'string' && endpoint.path ? endpoint.path : null;
  } catch {
    return null;
  }
}

/** The registry's projects as list entries; a missing or unreadable state directory is not an error. */
export function describeProjects(registry: { list(): ProjectRecord[] }): ProjectListEntry[] {
  return registry.list().map((project) => {
    const coordinatorRunning = findLiveCoordinator(project.stateDir) !== null;
    return {
      id: project.id,
      name: project.name,
      target_repo_root: project.canonicalGitRoot,
      state_dir: project.stateDir,
      repo_present: existsSync(project.canonicalGitRoot),
      control_socket: coordinatorRunning ? controlSocket(project.stateDir) : null,
      coordinator_running: coordinatorRunning,
    };
  });
}

/** The warning Node 24 prints when node:sqlite is first loaded. */
function isSqliteExperimentalWarning(warning: string | Error, typeOrOptions: unknown): boolean {
  const type = typeof typeOrOptions === 'string'
    ? typeOrOptions
    : (typeOrOptions as { type?: unknown } | undefined)?.type ?? (warning instanceof Error ? warning.name : undefined);
  const message = warning instanceof Error ? warning.message : String(warning);
  return type === 'ExperimentalWarning' && message.startsWith('SQLite is an experimental feature');
}

/**
 * node:sqlite, loaded without its ExperimentalWarning (it would print above
 * the `orc watch` dashboard). Node emits that warning synchronously on the
 * first load, so only that one is dropped while loading; every other warning
 * still goes through `process.emitWarning`.
 */
export function loadNodeSqlite(): typeof import('node:sqlite') {
  const original = Object.getOwnPropertyDescriptor(process, 'emitWarning');
  const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (!isSqliteExperimentalWarning(warning, rest[0])) emitWarning(warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return process.getBuiltinModule('node:sqlite');
  } finally {
    if (original) Object.defineProperty(process, 'emitWarning', original);
    else delete (process as { emitWarning?: unknown }).emitWarning;
  }
}

/**
 * The registered projects, read from registry.db opened read-only: no
 * table or migration is created, nor the data home or registry.db (SQLite
 * may still create the WAL's -shm/-wal files beside a WAL registry). Loading node:sqlite is
 * deferred to the first call, through `loadNodeSqlite`.
 */
function readRegistry(path: string): ProjectRecord[] {
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version > SUPPORTED_REGISTRY_SCHEMA_VERSION) throw new RegistrySchemaError(version);
    // A registry created but never initialised has no projects table yet.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get()) return [];
    const rows = db.prepare('SELECT id, name, git_root, state_dir, created_at FROM projects ORDER BY name, id').all() as Array<Record<string, string>>;
    return rows.map((row) => ({ id: row.id, name: row.name, canonicalGitRoot: row.git_root, stateDir: row.state_dir, createdAt: row.created_at }));
  } finally {
    db.close();
  }
}

/**
 * Every registered project with its control socket and whether its coordinator is up.
 * Returns `[]` when no registry exists; throws `RegistrySchemaError` for a newer registry schema.
 */
export function listProjects({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}): ProjectListEntry[] {
  const path = join(projectDataHome(env), 'registry.db');
  if (!existsSync(path)) return [];
  return describeProjects({ list: () => readRegistry(path) });
}
