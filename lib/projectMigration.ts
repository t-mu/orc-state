import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import Database from 'better-sqlite3';
import { discoverActiveTaskSpecs, syncBacklogFromSpecsLoaded, type SpecEntry } from './backlogSync.ts';
import { closeAllDatabases } from './eventLog.ts';
import { closeMemoryDb } from './memoryStore.ts';
import { parsePlan } from './planDocs.ts';
import { isPidAlive } from './processIdentity.ts';
import { MIGRATION_MARKER, MIGRATION_RECORD, projectMigrationStatus, readMigrationMarker, type MigrationMarker } from './projectContext.ts';
import { canonicalProjectGitRoot, validateProjectSetting, type ProjectRecord, type ProjectRegistry, type SettingValue } from './projectRegistry.ts';
import { closeProjectTaskStores, initProjectTaskStore, prepareProjectTask, refreshBacklogProjection, type TaskAuthoringInput } from './projectTasks.ts';
import { parseBodyTitle, ProjectTaskStore, revisionContentHash, type TaskDispatchState } from './projectTaskStore.ts';
import { ensureStateInitialized } from './stateInit.ts';
import { importPlanMarkdown, parseTaskMarkdown } from './taskMarkdown.ts';
import type { Backlog, Task, TaskStatus } from '../types/backlog.ts';

/**
 * Migration of a legacy attached or sibling installation (`.orc-state/`,
 * `backlog/`, `plans/`, `orc-state.config.json`) into a registered project
 * whose state lives under the data home. A dry run only reads. Execution
 * backs the legacy state up, imports task definitions with their effective
 * runtime status, copies run and event history, imports plans and settings,
 * verifies parity, and only then cuts the installation over. Retrying is
 * safe until the cutover, and a cut-over installation is left alone. Nothing
 * in the legacy installation is deleted; it only gains a marker naming its
 * project.
 */

const LEGACY_CONFIG = 'orc-state.config.json';
const SQLITE_FILES = ['events.db', 'memory.db'] as const;
const JSON_FILES = ['claims.json', 'agents.json', 'run-worktrees.json', 'event-checkpoint.json'] as const;
const HISTORY_DIRS = ['run-specs'] as const;
// Rebuilt from the copied state when a migration attempt is retried.
const PROJECT_STATE_FILES = ['runtime.db', 'backlog.json', ...SQLITE_FILES, ...JSON_FILES];

export interface LegacyInstallation {
  root: string;
  stateDir: string;
  configFile: string | null;
  layout: 'attached' | 'sibling';
  targetRepoRoot: string;
  backlogDir: string;
  plansDir: string;
  worktreesDir: string;
}

export interface MigrationIssue {
  severity: 'blocking' | 'warning';
  code: string;
  message: string;
  ref?: string;
  path?: string;
}

interface PlannedTask {
  ref: string;
  status: TaskStatus;
  source: 'spec' | 'archived_spec' | 'runtime';
  sourcePath: string | null;
  fileSha256: string | null;
  input: TaskAuthoringInput;
  dispatch: TaskDispatchState & { attemptCount: number };
  blockedReason: string | null;
  createdAt: string | undefined;
}

export interface MigrationInventory {
  source: { root: string; state_dir: string; config_file: string | null; layout: LegacyInstallation['layout']; target_repo_root: string; backlog_dir: string; plans_dir: string; worktrees_dir: string };
  tasks: { total: number; by_status: Record<string, number>; from_specs: number; from_archived_specs: number; runtime_only: number };
  plans: { importable: number; files: string[] };
  runs: { claims: number; active_claims: number; run_worktrees: number; run_specs: number };
  databases: Record<string, Record<string, number> | null>;
  worktrees: string[];
  settings: { importable: Record<string, SettingValue>; skipped: string[] };
  existing_project: { id: string; name: string; state_dir: string; migration_status: string | null } | null;
  migrated_to: MigrationMarker | null;
  issues: MigrationIssue[];
  blocking: number;
}

interface MigrationPlan {
  installation: LegacyInstallation;
  inventory: MigrationInventory;
  tasks: PlannedTask[];
  plans: string[];
  existing: ProjectRecord | null;
  fingerprint: string;
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function hasLayout(dir: string): boolean {
  return existsSync(join(dir, '.orc-state')) || existsSync(join(dir, LEGACY_CONFIG));
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * The legacy installation containing `path`: the nearest directory holding
 * `.orc-state/` or `orc-state.config.json`, normalized to the Git main
 * checkout when called from one of its worktrees.
 */
export function findLegacyInstallation(path: string): LegacyInstallation {
  let dir = realpathSync(resolve(path));
  for (;;) {
    if (hasLayout(dir)) break;
    if (dirname(dir) === dir) throw new Error(`No legacy orc installation (.orc-state/ or ${LEGACY_CONFIG}) at or above ${path}`);
    dir = dirname(dir);
  }
  try {
    // From a linked worktree of an attached installation, migrate the main checkout's installation.
    const main = canonicalProjectGitRoot(dir);
    const top = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
    if (top !== main && hasLayout(main)) dir = main;
  } catch {
    // Not a Git checkout: the orchestration home of a sibling layout need not be one.
  }
  const stateDir = join(dir, '.orc-state');
  if (!existsSync(stateDir)) throw new Error(`Legacy installation at ${dir} has no .orc-state/ to migrate`);
  const configFile = existsSync(join(dir, LEGACY_CONFIG)) ? join(dir, LEGACY_CONFIG) : null;
  const config = configFile ? readJsonFile<Record<string, unknown>>(configFile) : null;
  const targetRepo = typeof config?.target_repo === 'string' && config.target_repo ? resolve(dir, config.target_repo) : dir;
  const targetRepoRoot = canonicalProjectGitRoot(targetRepo);
  return {
    root: dir, stateDir, configFile,
    layout: typeof config?.target_repo === 'string' && targetRepoRoot !== dir ? 'sibling' : 'attached',
    targetRepoRoot,
    backlogDir: join(dir, 'backlog'), plansDir: join(dir, 'plans'), worktreesDir: join(dir, '.worktrees'),
  };
}

/** Row counts per table: the parity check for copied history databases. */
function tableCounts(path: string): Record<string, number> | null {
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    return Object.fromEntries(tables.map((name) => [name, (db.prepare(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n: number }).n]));
  } finally {
    db.close();
  }
}

function countFiles(dir: string): number {
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

/** Nested config objects become dotted registry keys; `target_repo` is replaced by registration. */
function flattenConfig(config: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
  return Object.entries(config).flatMap(([key, value]): Array<[string, unknown]> => {
    const name = prefix ? `${prefix}.${key}` : key;
    if (!prefix && key === 'target_repo') return [];
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? flattenConfig(value as Record<string, unknown>, name) : [[name, value]];
  });
}

function legacyTasks(backlog: Backlog): Array<{ feature: string; task: Task }> {
  return (backlog.features ?? []).flatMap((feature) => (feature.tasks ?? []).map((task) => ({ feature: feature.ref, task })));
}

function archivedSpecs(backlogDir: string, issues: MigrationIssue[]): Map<string, { path: string; text: string }> {
  const archived = new Map<string, { path: string; text: string }>();
  const dir = join(backlogDir, 'legacy');
  if (!existsSync(dir)) return archived;
  for (const relativePath of (readdirSync(dir, { recursive: true }) as string[]).filter((name) => name.endsWith('.md')).sort()) {
    const path = join(dir, relativePath);
    const text = readFileSync(path, 'utf8');
    const ref = /^---[ \t]*\r?\n[\s\S]*?^ref:[ \t]*(\S+)/m.exec(text)?.[1];
    if (!ref) continue;
    if (archived.has(ref)) issues.push({ severity: 'warning', code: 'duplicate_archived_spec', ref, path, message: `archived spec ${path} repeats ${ref}; the first one is used` });
    else archived.set(ref, { path, text });
  }
  return archived;
}

function specInput(parsed: NonNullable<ReturnType<typeof parseTaskMarkdown>>): TaskAuthoringInput {
  return { feature: parsed.feature, ref: parsed.ref.split('/')[1], title: parsed.title, body_markdown: parsed.bodyMarkdown, ...parsed.fields };
}

function runtimeInput(feature: string, task: Task): TaskAuthoringInput {
  return {
    feature: task.ref.split('/')[0] ?? feature, ref: task.ref.split('/')[1], title: task.title,
    description: task.description, acceptance_criteria: task.acceptance_criteria, depends_on: task.depends_on,
    priority: task.priority, required_provider: task.required_provider, model: task.model,
    review_level: task.review_level, merge_strategy: task.merge_strategy, required_capabilities: task.required_capabilities,
    task_type: task.task_type,
  };
}

function coordinatorRunning(stateDir: string): number | null {
  try {
    const pid = (JSON.parse(readFileSync(join(stateDir, 'coordinator.pid'), 'utf8')) as { pid?: unknown }).pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && isPidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Tasks plus plans in a project's runtime.db, read without migrating its schema. */
function projectContentCount(stateDir: string): number {
  const counts = tableCounts(join(stateDir, 'runtime.db'));
  return (counts?.tasks ?? 0) + (counts?.plan_documents ?? 0);
}

/** A digest of everything the migration reads, to detect a legacy installation that changed mid-migration. */
function sourceFingerprint(installation: LegacyInstallation): string {
  const hash = createHash('sha256');
  const add = (path: string) => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const name of (readdirSync(path, { recursive: true }) as string[]).sort()) {
        const file = join(path, name);
        if (statSync(file).isFile()) { hash.update(file); hash.update(readFileSync(file)); }
      }
      return;
    }
    hash.update(path);
    hash.update(readFileSync(path));
  };
  for (const name of ['backlog.json', ...JSON_FILES]) add(join(installation.stateDir, name));
  for (const name of [...HISTORY_DIRS]) add(join(installation.stateDir, name));
  if (installation.configFile) add(installation.configFile);
  add(installation.backlogDir);
  add(installation.plansDir);
  for (const name of SQLITE_FILES) hash.update(JSON.stringify(tableCounts(join(installation.stateDir, name))));
  return hash.digest('hex');
}

/** Read-only inventory of a legacy installation, with the task import it would perform. */
export function planMigration(path: string, registry: ProjectRegistry): MigrationPlan {
  const installation = findLegacyInstallation(path);
  const issues: MigrationIssue[] = [];
  const blocking = (code: string, message: string, extra: Partial<MigrationIssue> = {}) => issues.push({ severity: 'blocking', code, message, ...extra });
  const warning = (code: string, message: string, extra: Partial<MigrationIssue> = {}) => issues.push({ severity: 'warning', code, message, ...extra });

  // Effective runtime status: the stored backlog after the coordinator's own spec merge,
  // so a finished task is never reopened by a stale spec and pending spec edits still apply.
  let backlog: Backlog = { version: '1', features: [] };
  try {
    backlog = readJsonFile<Backlog>(join(installation.stateDir, 'backlog.json')) ?? backlog;
  } catch (error) {
    blocking('invalid_backlog', `backlog.json cannot be parsed: ${(error as Error).message}`, { path: join(installation.stateDir, 'backlog.json') });
  }
  const stored = new Map(legacyTasks(backlog).map(({ task }) => [task.ref, task.status]));
  let specs: SpecEntry[] = [];
  try {
    specs = discoverActiveTaskSpecs(installation.backlogDir);
  } catch (error) {
    blocking('invalid_spec', (error as Error).message, { path: installation.backlogDir });
  }
  const specsByRef = new Map<string, SpecEntry>();
  for (const spec of specs) {
    const previous = specsByRef.get(spec.ref);
    if (previous) blocking('duplicate_ref', `task ref ${spec.ref} is defined by both ${previous.file} and ${spec.file}`, { ref: spec.ref, path: join(installation.backlogDir, spec.file) });
    else specsByRef.set(spec.ref, spec);
  }
  const effective = structuredClone(backlog);
  syncBacklogFromSpecsLoaded(effective, [...specsByRef.values()]);
  const archived = archivedSpecs(installation.backlogDir, issues);

  const tasks: PlannedTask[] = [];
  for (const { feature, task } of legacyTasks(effective)) {
    const spec = specsByRef.get(task.ref);
    if (stored.get(task.ref) !== undefined && spec && spec.status !== task.status) {
      warning('status_conflict', `${task.ref}: spec says ${spec.status}, runtime says ${task.status}; the runtime status is kept`, { ref: task.ref, path: join(installation.backlogDir, spec.file) });
    }
    if (task.status === 'claimed' || task.status === 'in_progress') {
      blocking('active_task', `${task.ref} is ${task.status}; finish or reset it (orc task-reset) before migrating`, { ref: task.ref });
    }
    let source: PlannedTask['source'] = 'runtime';
    let sourcePath: string | null = null;
    let fileSha256: string | null = null;
    let input = runtimeInput(feature, task);
    const file = spec ? { path: join(installation.backlogDir, spec.file), text: spec.content } : archived.get(task.ref);
    if (file) {
      try {
        const parsed = parseTaskMarkdown(file.text, file.path);
        if (!parsed) throw new Error('missing ref frontmatter');
        input = specInput(parsed);
        source = spec ? 'spec' : 'archived_spec';
        sourcePath = file.path;
        fileSha256 = parsed.fileSha256;
      } catch (error) {
        if (spec) blocking('invalid_spec', `${file.path}: ${(error as Error).message}`, { ref: task.ref, path: file.path });
        else warning('invalid_archived_spec', `${file.path}: ${(error as Error).message}; ${task.ref} is rebuilt from runtime fields`, { ref: task.ref, path: file.path });
      }
    } else {
      warning('runtime_only', `${task.ref} has no spec file; its definition is rebuilt from runtime fields`, { ref: task.ref });
    }
    tasks.push({
      ref: task.ref, status: task.status, source, sourcePath, fileSha256, input,
      dispatch: {
        owner: task.owner ?? null, planningState: task.planning_state ?? null, delegatedBy: task.delegated_by ?? null,
        taskType: null, requeueEligibleAfter: task.requeue_eligible_after ?? null, attemptCount: task.attempt_count ?? 0,
      },
      blockedReason: task.status === 'blocked' ? (task.blocked_reason ?? 'blocked before migration') : null,
      createdAt: task.created_at,
    });
    // A runtime task type that differs from the definition is dispatch state, as in commitBacklog.
    const last = tasks.at(-1)!;
    const definitionType = (input.task_type as string | undefined) ?? 'implementation';
    if (task.task_type && task.task_type !== definitionType) last.dispatch.taskType = task.task_type;
  }
  const known = new Set(tasks.map((task) => task.ref));
  for (const task of tasks) {
    for (const dependency of (task.input.depends_on as string[] | undefined) ?? []) {
      if (!known.has(dependency)) warning('missing_dependency', `${task.ref} depends on unknown task ${dependency}; it will wait until that task exists`, { ref: task.ref });
    }
  }

  // Rehearse the import in a scratch store so validation and lifecycle rules fail here, not halfway through.
  const scratch = mkdtempSync(join(tmpdir(), 'orc-migrate-'));
  try {
    const store = new ProjectTaskStore(scratch);
    try {
      importPlannedTasks(store, tasks);
    } catch (error) {
      blocking('task_import', `task import would fail: ${(error as Error).message}`);
    } finally {
      store.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const claims = (() => {
    try {
      return readJsonFile<{ claims?: Array<{ run_id: string; task_ref: string; state: string }> }>(join(installation.stateDir, 'claims.json'))?.claims ?? [];
    } catch (error) {
      blocking('invalid_claims', `claims.json cannot be parsed: ${(error as Error).message}`);
      return [];
    }
  })();
  const activeClaims = claims.filter((claim) => claim.state === 'claimed' || claim.state === 'in_progress');
  for (const claim of activeClaims) blocking('active_claim', `run ${claim.run_id} (${claim.task_ref}) is still ${claim.state}; let it finish, or end it with orc run-expire or orc task-reset`, { ref: claim.task_ref });
  const runWorktrees = (() => {
    try {
      return readJsonFile<{ runs?: unknown[] }>(join(installation.stateDir, 'run-worktrees.json'))?.runs?.length ?? 0;
    } catch {
      warning('invalid_run_worktrees', 'run-worktrees.json cannot be parsed; it is copied unchanged');
      return 0;
    }
  })();
  const coordinatorPid = coordinatorRunning(installation.stateDir);
  if (coordinatorPid) blocking('coordinator_running', `the legacy coordinator is running (PID ${coordinatorPid}); stop it first (orc kill-all)`);

  const databases: Record<string, Record<string, number> | null> = {};
  for (const name of SQLITE_FILES) {
    try {
      databases[name] = tableCounts(join(installation.stateDir, name));
    } catch (error) {
      blocking('invalid_database', `${name} cannot be read: ${(error as Error).message}`, { path: join(installation.stateDir, name) });
      databases[name] = null;
    }
  }

  const plans: string[] = [];
  const planIds = new Map<number, string>();
  if (existsSync(installation.plansDir)) {
    for (const name of readdirSync(installation.plansDir).filter((entry) => /^\d+-[^/]+\.md$/.test(entry)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
      const file = join(installation.plansDir, name);
      try {
        const { planId } = parsePlan(file);
        if (planIds.has(planId)) { warning('duplicate_plan', `${file} repeats plan ${planId} (${planIds.get(planId)}); it is not imported`, { path: file }); continue; }
        planIds.set(planId, file);
        plans.push(file);
      } catch (error) {
        warning('invalid_plan', `${file} is not imported: ${(error as Error).message}`, { path: file });
      }
    }
  }

  const importable: Record<string, SettingValue> = {};
  const skipped: string[] = [];
  try {
    const config = installation.configFile ? readJsonFile<Record<string, unknown>>(installation.configFile) ?? {} : {};
    for (const [key, value] of flattenConfig(config)) {
      if (value === null) continue;
      try {
        importable[key] = validateProjectSetting(key, value);
      } catch (error) {
        skipped.push(key);
        warning('setting_skipped', `${key} is not imported: ${(error as Error).message}`, { path: installation.configFile! });
      }
    }
  } catch (error) {
    blocking('invalid_config', `${LEGACY_CONFIG} cannot be parsed: ${(error as Error).message}`, { path: installation.configFile! });
  }

  const marker = readMigrationMarker(installation.stateDir);
  const markedProject = marker ? registry.get(marker.project_id) : null;
  const existing = markedProject ?? registry.list().find((project) => project.canonicalGitRoot === installation.targetRepoRoot) ?? null;
  const existingStatus = existing ? projectMigrationStatus(existing.stateDir) : null;
  if (existing && !markedProject) {
    const record = readMigrationRecord(existing.stateDir);
    if (existingStatus === null) {
      if (projectContentCount(existing.stateDir) > 0) blocking('project_in_use', `project ${existing.name} (${existing.id}) is already registered for ${existing.canonicalGitRoot} and has its own tasks or plans`);
    } else if (record?.source_state_dir !== installation.stateDir) {
      blocking('project_in_use', `project ${existing.name} (${existing.id}) was migrated from another installation (${String(record?.source_state_dir)})`);
    }
  }

  const byStatus: Record<string, number> = {};
  for (const task of tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
  const inventory: MigrationInventory = {
    source: {
      root: installation.root, state_dir: installation.stateDir, config_file: installation.configFile, layout: installation.layout,
      target_repo_root: installation.targetRepoRoot, backlog_dir: installation.backlogDir, plans_dir: installation.plansDir, worktrees_dir: installation.worktreesDir,
    },
    tasks: {
      total: tasks.length, by_status: byStatus,
      from_specs: tasks.filter((task) => task.source === 'spec').length,
      from_archived_specs: tasks.filter((task) => task.source === 'archived_spec').length,
      runtime_only: tasks.filter((task) => task.source === 'runtime').length,
    },
    plans: { importable: plans.length, files: plans },
    runs: { claims: claims.length, active_claims: activeClaims.length, run_worktrees: runWorktrees, run_specs: countFiles(join(installation.stateDir, 'run-specs')) },
    databases,
    worktrees: existsSync(installation.worktreesDir) ? readdirSync(installation.worktreesDir).sort().map((name) => join(installation.worktreesDir, name)) : [],
    settings: { importable, skipped },
    existing_project: existing ? { id: existing.id, name: existing.name, state_dir: existing.stateDir, migration_status: existingStatus } : null,
    migrated_to: markedProject ? marker : null,
    issues,
    blocking: issues.filter((issue) => issue.severity === 'blocking').length,
  };
  return { installation, inventory, tasks, plans, existing, fingerprint: sourceFingerprint(installation) };
}

/** Create every planned task, with its runtime status as its first transition, in one transaction. */
function importPlannedTasks(store: ProjectTaskStore, tasks: readonly PlannedTask[]): void {
  store.inTransaction(() => {
    for (const task of tasks) {
      const { spec } = prepareProjectTask(store, task.input, 'human');
      store.createTask({ ...spec, ...(task.createdAt ? { createdAt: task.createdAt } : {}) });
      if (task.status !== 'todo') {
        store.applyTransition(task.ref, {
          cause: 'migration_import', to: task.status, actorId: 'human', idempotencyKey: 'migration_import',
          reason: task.blockedReason ?? 'status carried over from the legacy installation',
        });
      }
      store.setDispatchState(task.ref, task.dispatch);
      if (task.sourcePath && task.fileSha256) store.recordImport(task.ref, 1, task.sourcePath, task.fileSha256);
    }
  });
}

interface MigrationRecord {
  status: 'importing' | 'verification_failed' | 'verified' | 'cut_over';
  project_id: string;
  source_root: string;
  source_state_dir: string;
  layout: LegacyInstallation['layout'];
  target_repo_root: string;
  backup_dir: string | null;
  attempts: number;
  started_at: string;
  updated_at: string;
  cut_over_at?: string;
  mismatches?: string[];
  /** Project-scoped setting keys this migration imported; a retry replaces them. */
  settings?: string[];
}

function readMigrationRecord(stateDir: string): MigrationRecord | null {
  try {
    return readJsonFile<MigrationRecord>(join(stateDir, MIGRATION_RECORD));
  } catch {
    return null;
  }
}

function writeMigrationRecord(stateDir: string, record: MigrationRecord): void {
  writeFileSync(join(stateDir, MIGRATION_RECORD), `${JSON.stringify({ ...record, updated_at: new Date().toISOString() }, null, 2)}\n`);
}

function removeSqlite(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
}

/** A consistent single-file copy of a live or WAL-mode SQLite database. */
function copySqlite(source: string, destination: string): void {
  removeSqlite(destination);
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    db.prepare('VACUUM INTO ?').run(destination);
  } finally {
    db.close();
  }
}

/** Copy the legacy installation's own files, unchanged, into a timestamped backup directory. */
function backupInstallation(installation: LegacyInstallation, backupDir: string): void {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const state = join(backupDir, 'state');
  cpSync(installation.stateDir, state, {
    recursive: true,
    filter: (source) => !/\.db-(wal|shm)$/.test(source) && !SQLITE_FILES.some((name) => source === join(installation.stateDir, name)),
  });
  for (const name of SQLITE_FILES) {
    if (existsSync(join(installation.stateDir, name))) copySqlite(join(installation.stateDir, name), join(state, name));
  }
  if (existsSync(installation.backlogDir)) cpSync(installation.backlogDir, join(backupDir, 'backlog'), { recursive: true });
  if (existsSync(installation.plansDir)) cpSync(installation.plansDir, join(backupDir, 'plans'), { recursive: true });
  if (installation.configFile) cpSync(installation.configFile, join(backupDir, LEGACY_CONFIG));
}

/** Copy run and event history; snapshot paths inside the old state directory follow the copy. */
function copyHistory(installation: LegacyInstallation, stateDir: string): void {
  for (const name of SQLITE_FILES) {
    if (existsSync(join(installation.stateDir, name))) copySqlite(join(installation.stateDir, name), join(stateDir, name));
  }
  for (const name of HISTORY_DIRS) {
    rmSync(join(stateDir, name), { recursive: true, force: true });
    if (existsSync(join(installation.stateDir, name))) cpSync(join(installation.stateDir, name), join(stateDir, name), { recursive: true });
  }
  for (const name of JSON_FILES) {
    const source = join(installation.stateDir, name);
    if (!existsSync(source)) continue;
    let text = readFileSync(source, 'utf8');
    if (name === 'claims.json') text = text.split(JSON.stringify(join(installation.stateDir, 'run-specs')).slice(1, -1)).join(JSON.stringify(join(stateDir, 'run-specs')).slice(1, -1));
    if (name === 'agents.json') {
      // Sessions belonged to the legacy coordinator; the project's coordinator starts its own.
      const agents = JSON.parse(text) as { agents?: Array<Record<string, unknown>> };
      for (const agent of agents.agents ?? []) Object.assign(agent, { status: 'offline', session_handle: null, session_token: null, session_started_at: null, session_ready_at: null });
      text = `${JSON.stringify(agents, null, 2)}\n`;
    }
    writeFileSync(join(stateDir, name), text);
  }
}

/** Compare the project's state with the plan; an empty list means parity. */
function verifyParity(plan: MigrationPlan, stateDir: string, registry: ProjectRegistry, projectId: string): string[] {
  const mismatches: string[] = [];
  const store = initProjectTaskStore(stateDir);
  const imported = new Map(store.listTasks().map((task) => [task.ref, task]));
  if (imported.size !== plan.tasks.length) mismatches.push(`task count: expected ${plan.tasks.length}, found ${imported.size}`);
  for (const expected of plan.tasks) {
    const task = imported.get(expected.ref);
    if (!task) { mismatches.push(`${expected.ref}: missing`); continue; }
    const { spec } = prepareProjectTask({ getTask: () => null }, expected.input, 'human');
    const title = spec.title ?? parseBodyTitle(spec.bodyMarkdown);
    // The revision hash covers the whole definition: title, body, metadata, priority, provider and dependencies.
    const metadata = { ...spec.metadata, priority: spec.priority ?? 'normal', required_provider: spec.requiredProvider ?? null, depends_on: [...new Set(spec.dependsOn ?? [])].sort() };
    const checks: Array<[string, unknown, unknown]> = [
      ['definition', revisionContentHash(title ?? '', spec.bodyMarkdown, metadata), task.contentHash],
      ['status', expected.status, task.status],
      ['title', spec.title ?? parseBodyTitle(spec.bodyMarkdown), task.title],
      ['body', spec.bodyMarkdown, task.bodyMarkdown],
      ['depends_on', JSON.stringify([...new Set(spec.dependsOn ?? [])].sort()), JSON.stringify(task.dependsOn)],
      ['attempt_count', expected.dispatch.attemptCount, task.attemptCount],
      ['owner', expected.dispatch.owner, task.dispatch.owner],
      ['planning_state', expected.dispatch.planningState, task.dispatch.planningState],
      ['delegated_by', expected.dispatch.delegatedBy, task.dispatch.delegatedBy],
      ['task_type', expected.dispatch.taskType, task.dispatch.taskType],
      ['requeue_eligible_after', expected.dispatch.requeueEligibleAfter, task.dispatch.requeueEligibleAfter],
      ['blocked_reason', expected.blockedReason, task.blockedReason],
    ];
    for (const [field, want, got] of checks) if (want !== got) mismatches.push(`${expected.ref}: ${field} expected ${JSON.stringify(want)}, found ${JSON.stringify(got)}`);
  }
  for (const name of SQLITE_FILES) {
    const want = plan.inventory.databases[name];
    const got = tableCounts(join(stateDir, name));
    if (want && JSON.stringify(want) !== JSON.stringify(got)) mismatches.push(`${name}: table row counts differ (expected ${JSON.stringify(want)}, found ${JSON.stringify(got)})`);
  }
  const claims = readJsonFile<{ claims?: unknown[] }>(join(stateDir, 'claims.json'))?.claims?.length ?? 0;
  if (claims !== plan.inventory.runs.claims) mismatches.push(`claims: expected ${plan.inventory.runs.claims}, found ${claims}`);
  if (countFiles(join(stateDir, 'run-specs')) !== plan.inventory.runs.run_specs) mismatches.push('run-specs: snapshot count differs');
  for (const file of plan.plans) {
    const { planId } = parsePlan(file);
    if (store.getPlan(planId)?.bodyMarkdown !== readFileSync(file, 'utf8')) mismatches.push(`plan ${planId}: content differs from ${file}`);
  }
  const settings = registry.settings(projectId);
  for (const key of new Set([...Object.keys(settings), ...Object.keys(plan.inventory.settings.importable)])) {
    const want = plan.inventory.settings.importable[key];
    if (settings[key] !== want) mismatches.push(`setting ${key}: expected ${JSON.stringify(want)}, found ${JSON.stringify(settings[key])}`);
  }
  if (sourceFingerprint(plan.installation) !== plan.fingerprint) mismatches.push('the legacy installation changed during the migration; rerun it once nothing is writing to it');
  return mismatches;
}

export interface MigrationResult {
  status: 'dry_run' | 'blocked' | 'already_migrated' | 'verification_failed' | 'migrated';
  project: ProjectRecord | null;
  backup_dir?: string | null;
  mismatches?: string[];
  inventory: MigrationInventory;
}

/**
 * Inventory (dry run) or migrate a legacy installation. Execution refuses
 * while any blocking issue remains, and retries rebuild the project's state
 * from the unchanged legacy files until the cutover.
 */
export function migrateLegacyInstallation(path: string, registry: ProjectRegistry, { execute = false, name }: { execute?: boolean; name?: string | undefined } = {}): MigrationResult {
  const plan = planMigration(path, registry);
  const { installation, inventory } = plan;
  if (inventory.migrated_to) {
    const project = registry.get(inventory.migrated_to.project_id)!;
    // A cutover interrupted after the marker was written finishes here.
    const record = readMigrationRecord(project.stateDir);
    if (execute && record && record.status !== 'cut_over') writeMigrationRecord(project.stateDir, { ...record, status: 'cut_over', cut_over_at: inventory.migrated_to.migrated_at });
    return { status: 'already_migrated', project, inventory };
  }
  if (!execute) return { status: 'dry_run', project: plan.existing, inventory };
  if (inventory.blocking > 0) return { status: 'blocked', project: plan.existing, inventory };

  // Hold the legacy coordinator lock so a legacy coordinator cannot start while its state is copied.
  const lockFile = join(installation.stateDir, 'coordinator.pid');
  try {
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), migration: true }), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || coordinatorRunning(installation.stateDir)) {
      inventory.issues.push({ severity: 'blocking', code: 'coordinator_running', message: 'the legacy coordinator lock is held; stop the coordinator and retry' });
      inventory.blocking += 1;
      return { status: 'blocked', project: plan.existing, inventory };
    }
    // A stale lock from a dead coordinator.
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), migration: true }));
  }
  try {
    return executeMigration(plan, registry, name);
  } finally {
    rmSync(lockFile, { force: true });
  }
}

function executeMigration(plan: MigrationPlan, registry: ProjectRegistry, name: string | undefined): MigrationResult {
  const { installation, inventory } = plan;
  closeProjectTaskStores();
  closeAllDatabases();
  closeMemoryDb();
  const now = new Date().toISOString();
  const recordFor = (project: ProjectRecord, previous: MigrationRecord | null): MigrationRecord => ({
    status: 'importing', project_id: project.id, source_root: installation.root, source_state_dir: installation.stateDir,
    layout: installation.layout, target_repo_root: installation.targetRepoRoot,
    backup_dir: previous?.backup_dir && existsSync(previous.backup_dir) ? previous.backup_dir : null,
    attempts: (previous?.attempts ?? 0) + 1, started_at: previous?.started_at ?? now, updated_at: now,
    ...(previous?.settings ? { settings: previous.settings } : {}),
  });
  // A new project carries its migration record before it is registered, so it is never active half-imported.
  const project = plan.existing ?? registry.add(installation.targetRepoRoot, name, (created) => writeMigrationRecord(created.stateDir, recordFor(created, null)));
  const record = plan.existing ? recordFor(project, readMigrationRecord(project.stateDir)) : recordFor(project, null);
  writeMigrationRecord(project.stateDir, record);
  if (!record.backup_dir) {
    record.backup_dir = join(project.stateDir, 'migration-backup', now.replace(/[:.]/g, '-'));
    backupInstallation(installation, record.backup_dir);
    writeMigrationRecord(project.stateDir, record);
  }

  // Each attempt rebuilds project state from the legacy files, so a retry never doubles anything.
  for (const file of PROJECT_STATE_FILES) {
    if (file.endsWith('.db')) removeSqlite(join(project.stateDir, file));
    else rmSync(join(project.stateDir, file), { force: true });
  }
  copyHistory(installation, project.stateDir);
  ensureStateInitialized(project.stateDir);
  const store = initProjectTaskStore(project.stateDir);
  importPlannedTasks(store, plan.tasks);
  for (const file of plan.plans) importPlanMarkdown(project.stateDir, file);
  for (const key of record.settings ?? []) registry.unsetSetting(key, project.id);
  for (const [key, value] of Object.entries(inventory.settings.importable)) registry.setSetting(key, value, project.id);
  record.settings = Object.keys(inventory.settings.importable);
  writeMigrationRecord(project.stateDir, record);
  refreshBacklogProjection(project.stateDir);

  const mismatches = verifyParity(plan, project.stateDir, registry, project.id);
  if (mismatches.length > 0) {
    writeMigrationRecord(project.stateDir, { ...record, status: 'verification_failed', mismatches });
    return { status: 'verification_failed', project, backup_dir: record.backup_dir, mismatches, inventory };
  }
  writeMigrationRecord(project.stateDir, { ...record, status: 'verified' });
  const marker: MigrationMarker = {
    project_id: project.id, project_name: project.name, project_state_dir: project.stateDir,
    target_repo_root: project.canonicalGitRoot, migrated_at: new Date().toISOString(),
  };
  writeFileSync(join(installation.stateDir, MIGRATION_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  writeMigrationRecord(project.stateDir, { ...record, status: 'cut_over', cut_over_at: marker.migrated_at });
  return { status: 'migrated', project, backup_dir: record.backup_dir, mismatches: [], inventory };
}

export interface CleanupItem { path: string; kind: string; note: string }

/**
 * What a cut-over installation leaves behind, for the operator to remove.
 * Nothing is deleted here.
 */
export function migrationCleanupReport(path: string, registry: ProjectRegistry): { project: ProjectRecord; backup_dir: string | null; items: CleanupItem[]; commands: string[] } {
  const installation = findLegacyInstallation(path);
  const marker = readMigrationMarker(installation.stateDir);
  const project = marker ? registry.get(marker.project_id) : null;
  if (!marker || !project || projectMigrationStatus(project.stateDir) !== 'cut_over') {
    throw new Error(`${installation.root} has not been migrated; run orc project migrate --execute first`);
  }
  const items: CleanupItem[] = [];
  const commands: string[] = [];
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  let gitWorktrees: string[] = [];
  try {
    gitWorktrees = execFileSync('git', ['-C', installation.targetRepoRoot, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
  } catch {
    // Reported without Git's view of the worktrees.
  }
  for (const worktree of gitWorktrees.filter((entry) => within(installation.worktreesDir, entry))) {
    items.push({ path: worktree, kind: 'git_worktree', note: 'legacy run worktree still registered with Git' });
    commands.push(`git -C ${quote(installation.targetRepoRoot)} worktree remove ${quote(worktree)}`);
  }
  if (existsSync(installation.worktreesDir)) {
    items.push({ path: installation.worktreesDir, kind: 'worktrees_dir', note: 'legacy run worktrees; new runs use the project state directory' });
    commands.push(`git -C ${quote(installation.targetRepoRoot)} worktree prune`, `rm -r ${quote(installation.worktreesDir)}`);
  }
  // Specs, plans and config go before the state directory that holds the migration marker.
  const owned: Array<[string, string, string]> = [
    [installation.backlogDir, 'backlog_dir', 'task specs; imported into project SQLite (export with orc project task export)'],
    [installation.plansDir, 'plans_dir', 'plans; imported into project SQLite (export with orc project plan export)'],
  ];
  if (installation.configFile) owned.push([installation.configFile, 'config_file', 'settings; imported into the project registry']);
  owned.push([installation.stateDir, 'state_dir', 'legacy state; copied into the project and backed up']);
  for (const [target, kind, note] of owned) {
    if (!existsSync(target)) continue;
    items.push({ path: target, kind, note });
    commands.push(statSync(target).isDirectory() ? `rm -r ${quote(target)}` : `rm ${quote(target)}`);
  }
  const gitignore = join(installation.targetRepoRoot, '.gitignore');
  if (existsSync(gitignore) && /^(\.orc-state|\.worktrees)\/?\s*$/m.test(readFileSync(gitignore, 'utf8'))) {
    items.push({ path: gitignore, kind: 'gitignore_entry', note: 'contains .orc-state/ or .worktrees entries the project no longer needs' });
  }
  for (const file of ['.mcp.json', join('.codex', 'config.toml')]) {
    const target = join(installation.root, file);
    if (existsSync(target) && readFileSync(target, 'utf8').includes('orchestrator')) {
      items.push({ path: target, kind: 'provider_config', note: 'orchestrator MCP entry written by the legacy start-session' });
    }
  }
  return { project, backup_dir: readMigrationRecord(project.stateDir)?.backup_dir ?? null, items, commands };
}
