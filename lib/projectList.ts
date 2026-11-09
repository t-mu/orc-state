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
  /** Unix socket from the project's `control.json`; null when the state directory or endpoint file is missing or unreadable. */
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
    return {
      id: project.id,
      name: project.name,
      target_repo_root: project.canonicalGitRoot,
      state_dir: project.stateDir,
      control_socket: controlSocket(project.stateDir),
      coordinator_running: findLiveCoordinator(project.stateDir) !== null,
    };
  });
}

/**
 * The registered projects, read from registry.db opened read-only: no
 * table or migration is created, nor the data home or registry.db (SQLite
 * may still create the WAL's -shm/-wal files beside a WAL registry). Loading node:sqlite is
 * deferred to the first call (it prints an ExperimentalWarning on Node 24).
 */
function readRegistry(path: string): ProjectRecord[] {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
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
