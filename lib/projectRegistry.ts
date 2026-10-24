import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { selectProject } from './projectContract.ts';

export interface ProjectRecord {
  id: string;
  name: string;
  canonicalGitRoot: string;
  stateDir: string;
  createdAt: string;
}

export type SettingValue = string | number | null;
type SettingKind = 'provider' | 'execution_mode' | 'runtime' | 'string' | 'nonnegative' | 'positive' | 'merge_strategy' | 'pr_provider';

const SETTING_KINDS: Readonly<Record<string, SettingKind>> = {
  default_provider: 'provider',
  default_execution_mode: 'execution_mode',
  'master.provider': 'provider',
  'master.model': 'string',
  'master.execution_mode': 'execution_mode',
  'worker_pool.max_workers': 'nonnegative',
  'worker_pool.provider': 'provider',
  'worker_pool.model': 'string',
  'worker_pool.execution_mode': 'execution_mode',
  'worker_pool.runtime': 'runtime',
  'coordinator.mode': 'string',
  'coordinator.tick_interval_ms': 'positive',
  'coordinator.concurrency_limit': 'positive',
  'coordinator.run_start_timeout_ms': 'positive',
  'coordinator.session_ready_timeout_ms': 'positive',
  'coordinator.session_ready_nudge_ms': 'positive',
  'coordinator.session_ready_nudge_interval_ms': 'positive',
  'coordinator.run_inactive_timeout_ms': 'positive',
  'coordinator.run_inactive_nudge_ms': 'positive',
  'coordinator.run_inactive_escalate_ms': 'positive',
  'coordinator.run_inactive_nudge_interval_ms': 'positive',
  'coordinator.session_start_max_attempts': 'positive',
  'coordinator.session_start_retry_delay_ms': 'positive',
  'coordinator.memory_prune_interval_ms': 'nonnegative',
  'coordinator.worker_stale_soft_ms': 'positive',
  'coordinator.worker_stale_nudge_ms': 'positive',
  'coordinator.worker_stale_force_fail_ms': 'positive',
  'coordinator.merge_strategy': 'merge_strategy',
  'coordinator.pr_provider': 'pr_provider',
  'coordinator.pr_push_remote': 'string',
  'coordinator.pr_finalize_lease_ms': 'positive',
  'leases.default_ms': 'positive',
  'leases.finalize_ms': 'positive',
};

const ENV_KEYS: Readonly<Record<string, string>> = {
  default_provider: 'ORC_DEFAULT_PROVIDER',
  default_execution_mode: 'ORC_DEFAULT_EXECUTION_MODE',
  'master.provider': 'ORC_MASTER_PROVIDER',
  'master.model': 'ORC_MASTER_MODEL',
  'master.execution_mode': 'ORC_MASTER_EXECUTION_MODE',
  'worker_pool.max_workers': 'ORC_MAX_WORKERS',
  'worker_pool.provider': 'ORC_WORKER_PROVIDER',
  'worker_pool.model': 'ORC_WORKER_MODEL',
  'worker_pool.execution_mode': 'ORC_WORKER_EXECUTION_MODE',
  'worker_pool.runtime': 'ORC_WORKER_RUNTIME',
};

function settingKind(key: string): SettingKind {
  if (/^worker_pool\.provider_models\.(codex|claude|gemini)$/.test(key)) return 'string';
  const kind = SETTING_KINDS[key];
  if (!kind) throw new Error(`Unknown or secret-bearing project setting: ${key}`);
  return kind;
}

export function validateProjectSetting(key: string, value: unknown): SettingValue {
  const kind = settingKind(key);
  if (value === null && (kind === 'string' || kind === 'pr_provider')) return null;
  if (kind === 'nonnegative' || kind === 'positive') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < (kind === 'positive' ? 1 : 0)) {
      throw new Error(`${key} must be a ${kind === 'positive' ? 'positive' : 'non-negative'} integer`);
    }
    return value;
  }
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`);
  const choices: Partial<Record<SettingKind, readonly string[]>> = {
    provider: ['codex', 'claude', 'gemini'],
    execution_mode: ['full-access', 'sandbox'],
    runtime: ['cli', 'structured'],
    merge_strategy: ['direct', 'pr'],
    pr_provider: ['github'],
  };
  if (choices[kind] && !choices[kind].includes(value)) throw new Error(`Invalid ${key}: ${value}`);
  return value;
}

export function projectDataHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORC_DATA_HOME !== undefined) {
    if (!env.ORC_DATA_HOME.trim()) throw new Error('ORC_DATA_HOME must be a non-empty path');
    return resolve(env.ORC_DATA_HOME);
  }
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'orc-state');
  return join(env.XDG_DATA_HOME ? resolve(env.XDG_DATA_HOME) : join(homedir(), '.local', 'share'), 'orc-state');
}

/** Worktrees and symlinks resolve to the owning repository's canonical root. */
export function canonicalProjectGitRoot(path: string): string {
  const cwd = realpathSync(resolve(path));
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const canonicalTop = realpathSync(top);
  const canonicalCommon = realpathSync(common);
  return canonicalCommon === join(canonicalTop, '.git') ? canonicalTop :
    canonicalCommon.endsWith('/.git') ? dirname(canonicalCommon) : canonicalTop;
}

function mapProject(row: Record<string, string>): ProjectRecord {
  return { id: row.id, name: row.name, canonicalGitRoot: row.git_root, stateDir: row.state_dir, createdAt: row.created_at };
}

export class ProjectRegistry {
  private readonly db: Database.Database;
  readonly dataHome: string;

  constructor(dataHome = projectDataHome()) {
    this.dataHome = resolve(dataHome);
    mkdirSync(this.dataHome, { recursive: true, mode: 0o700 });
    this.db = new Database(join(this.dataHome, 'registry.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 1) {
      this.db.close();
      throw new Error(`registry.db schema version ${version} is newer than supported version 1`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        git_root TEXT NOT NULL UNIQUE,
        state_dir TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL CHECK (json_valid(value_json)),
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE IF NOT EXISTS registry_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    if (version === 0) this.db.pragma('user_version = 1');
  }

  close(): void { this.db.close(); }

  add(path: string, name?: string): ProjectRecord {
    const gitRoot = canonicalProjectGitRoot(path);
    const id = randomUUID();
    const stateDir = join(this.dataHome, 'projects', id);
    const project: ProjectRecord = { id, name: name?.trim() || gitRoot.split('/').at(-1) || id, canonicalGitRoot: gitRoot, stateDir, createdAt: new Date().toISOString() };
    try {
      this.db.prepare('INSERT INTO projects (id, name, git_root, state_dir, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, project.name, gitRoot, stateDir, project.createdAt);
    } catch (error) {
      if ((error as Error).message.includes('UNIQUE constraint failed: projects.git_root')) throw new Error(`Git repository is already registered: ${gitRoot}`);
      throw error;
    }
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    return project;
  }

  list(): ProjectRecord[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY name, id').all() as Record<string, string>[]).map(mapProject);
  }

  get(id: string): ProjectRecord | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, string> | undefined;
    return row ? mapProject(row) : null;
  }

  selectedId(): string | null {
    const row = this.db.prepare("SELECT value FROM registry_meta WHERE key = 'selected_project_id'").get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  select(id: string): ProjectRecord {
    const project = this.get(id);
    if (!project) throw new Error(`Project is not registered: ${id}`);
    this.db.prepare("INSERT INTO registry_meta (key, value) VALUES ('selected_project_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id);
    return project;
  }

  resolve({ explicitProjectId, env = process.env, cwd = process.cwd() }: { explicitProjectId?: string | null; env?: NodeJS.ProcessEnv; cwd?: string } = {}): ProjectRecord {
    let cwdGitRoot: string | null = null;
    try { cwdGitRoot = canonicalProjectGitRoot(cwd); }
    catch { /* Outside a Git repository, the selected project may apply. */ }
    const { projectId } = selectProject({ projects: this.list(), explicitProjectId: explicitProjectId ?? null, environmentProjectId: env.ORC_PROJECT_ID ?? null, cwdGitRoot, selectedProjectId: this.selectedId() });
    return this.get(projectId)!;
  }

  setSetting(key: string, value: unknown, projectId?: string): void {
    const checked = validateProjectSetting(key, value);
    if (projectId && !this.get(projectId)) throw new Error(`Project is not registered: ${projectId}`);
    this.db.prepare('INSERT INTO settings (scope, key, value_json) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value_json = excluded.value_json')
      .run(projectId ?? '', key, JSON.stringify(checked));
  }

  unsetSetting(key: string, projectId?: string): void {
    settingKind(key);
    if (projectId && !this.get(projectId)) throw new Error(`Project is not registered: ${projectId}`);
    this.db.prepare('DELETE FROM settings WHERE scope = ? AND key = ?').run(projectId ?? '', key);
  }

  settings(projectId?: string): Record<string, SettingValue> {
    if (projectId && !this.get(projectId)) throw new Error(`Project is not registered: ${projectId}`);
    const rows = this.db.prepare('SELECT key, value_json FROM settings WHERE scope = ? ORDER BY key').all(projectId ?? '') as Array<{ key: string; value_json: string }>;
    return Object.fromEntries(rows.map(({ key, value_json }) => [key, JSON.parse(value_json) as SettingValue]));
  }

  effectiveSettings(projectId: string, cli: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): Record<string, SettingValue> {
    const effective = { ...this.settings(), ...this.settings(projectId) };
    for (const [key, envName] of Object.entries(ENV_KEYS)) {
      const raw = env[envName];
      if (raw !== undefined) effective[key] = validateProjectSetting(key, settingKind(key) === 'positive' || settingKind(key) === 'nonnegative' ? Number(raw) : raw);
    }
    for (const [key, value] of Object.entries(cli)) effective[key] = validateProjectSetting(key, value);
    return effective;
  }
}
