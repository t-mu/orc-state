import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { TaskStatus } from '../types/backlog.ts';
import type { TaskTransitionCause } from './projectContract.ts';

export const PROJECT_TASK_SCHEMA_VERSION = 1;

const REQUIRED_TABLES = ['schema_migrations', 'tasks', 'task_spec_revisions', 'task_dependencies', 'task_transitions', 'task_runs'];

/** A separate project database: legacy events.db remains untouched until cutover. */
export function migrateProjectTaskSchema(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > PROJECT_TASK_SCHEMA_VERSION) throw new Error(`runtime.db schema version ${version} is newer than supported version ${PROJECT_TASK_SCHEMA_VERSION}`);
  if (version === 0) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
        CREATE TABLE tasks (
          ref TEXT PRIMARY KEY CHECK (length(trim(ref)) > 0),
          title TEXT NOT NULL CHECK (length(trim(title)) > 0),
          priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
          required_provider TEXT CHECK (required_provider IS NULL OR required_provider IN ('codex','claude','gemini')),
          status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','claimed','in_progress','blocked','done','released','cancelled')),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          blocked_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX tasks_status_priority_idx ON tasks(status, priority, created_at);
        CREATE TABLE task_spec_revisions (
          task_ref TEXT NOT NULL REFERENCES tasks(ref) ON DELETE RESTRICT,
          revision INTEGER NOT NULL CHECK (revision > 0),
          content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
          body_markdown TEXT NOT NULL,
          title TEXT NOT NULL CHECK (length(trim(title)) > 0),
          metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
          created_at TEXT NOT NULL,
          PRIMARY KEY (task_ref, revision)
        );
        CREATE TABLE task_dependencies (
          task_ref TEXT NOT NULL REFERENCES tasks(ref) ON DELETE CASCADE,
          depends_on_ref TEXT NOT NULL CHECK (length(trim(depends_on_ref)) > 0),
          PRIMARY KEY (task_ref, depends_on_ref),
          CHECK (task_ref <> depends_on_ref)
        );
        CREATE INDEX task_dependencies_target_idx ON task_dependencies(depends_on_ref);
        CREATE TABLE task_transitions (
          transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_ref TEXT NOT NULL REFERENCES tasks(ref) ON DELETE RESTRICT,
          from_status TEXT NOT NULL,
          to_status TEXT NOT NULL,
          cause TEXT NOT NULL,
          reason TEXT,
          run_id TEXT,
          idempotency_key TEXT,
          created_at TEXT NOT NULL,
          UNIQUE (task_ref, idempotency_key),
          CHECK (to_status <> 'blocked' OR (reason IS NOT NULL AND length(trim(reason)) > 0))
        );
        CREATE INDEX task_transitions_ref_idx ON task_transitions(task_ref, transition_id);
        CREATE TABLE task_runs (
          run_id TEXT PRIMARY KEY,
          task_ref TEXT NOT NULL,
          spec_revision INTEGER NOT NULL,
          agent_id TEXT,
          state TEXT NOT NULL CHECK (state IN ('claimed','in_progress','work_complete','finished','failed','cancelled')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (task_ref, spec_revision) REFERENCES task_spec_revisions(task_ref, revision) ON DELETE RESTRICT
        );
        CREATE UNIQUE INDEX task_runs_one_active_task_idx ON task_runs(task_ref)
          WHERE state IN ('claimed','in_progress','work_complete');
        CREATE TRIGGER task_runs_binding_immutable BEFORE UPDATE OF task_ref, spec_revision ON task_runs
          BEGIN SELECT RAISE(ABORT, 'run task and revision are immutable'); END;
        CREATE TRIGGER tasks_ref_immutable BEFORE UPDATE OF ref ON tasks BEGIN SELECT RAISE(ABORT, 'task ref is immutable'); END;
        CREATE TRIGGER revisions_immutable_update BEFORE UPDATE ON task_spec_revisions BEGIN SELECT RAISE(ABORT, 'spec revision is immutable'); END;
        CREATE TRIGGER revisions_immutable_delete BEFORE DELETE ON task_spec_revisions BEGIN SELECT RAISE(ABORT, 'spec revision is immutable'); END;
        CREATE TRIGGER transitions_immutable_update BEFORE UPDATE ON task_transitions BEGIN SELECT RAISE(ABORT, 'task transition is immutable'); END;
        CREATE TRIGGER transitions_immutable_delete BEFORE DELETE ON task_transitions BEGIN SELECT RAISE(ABORT, 'task transition is immutable'); END;
        CREATE TRIGGER transitions_validate BEFORE INSERT ON task_transitions BEGIN
          SELECT CASE WHEN (SELECT status FROM tasks WHERE ref = NEW.task_ref) <> NEW.from_status
            THEN RAISE(ABORT, 'stale task status') END;
          SELECT CASE WHEN NOT (
            (NEW.cause = 'claim' AND NEW.from_status = 'todo' AND NEW.to_status = 'claimed') OR
            (NEW.cause = 'run_start' AND NEW.from_status = 'claimed' AND NEW.to_status = 'in_progress') OR
            (NEW.cause = 'merge_succeeded' AND NEW.from_status = 'in_progress' AND NEW.to_status = 'done') OR
            (NEW.cause = 'post_merge_release' AND NEW.from_status = 'done' AND NEW.to_status = 'released') OR
            (NEW.cause = 'failure_requeue' AND NEW.from_status IN ('claimed','in_progress') AND NEW.to_status = 'todo') OR
            (NEW.cause = 'failure_block' AND NEW.from_status IN ('claimed','in_progress') AND NEW.to_status = 'blocked') OR
            (NEW.cause = 'manual_block' AND NEW.from_status = 'todo' AND NEW.to_status = 'blocked') OR
            (NEW.cause = 'unblock' AND NEW.from_status = 'blocked' AND NEW.to_status = 'todo') OR
            (NEW.cause = 'operator_reset' AND NEW.from_status <> 'todo' AND NEW.to_status = 'todo') OR
            (NEW.cause = 'cancel' AND NEW.from_status IN ('todo','claimed','in_progress','blocked') AND NEW.to_status = 'cancelled')
          ) THEN RAISE(ABORT, 'invalid task transition') END;
        END;
        CREATE TRIGGER tasks_status_guard BEFORE UPDATE OF status ON tasks
          WHEN OLD.status <> NEW.status AND NOT EXISTS (
            SELECT 1 FROM task_transitions WHERE task_ref = OLD.ref
              AND from_status = OLD.status AND to_status = NEW.status
              AND transition_id = (SELECT MAX(transition_id) FROM task_transitions WHERE task_ref = OLD.ref)
          ) BEGIN SELECT RAISE(ABORT, 'task status requires a transition'); END;
        CREATE TRIGGER transitions_apply AFTER INSERT ON task_transitions BEGIN
          UPDATE tasks SET status = NEW.to_status,
            blocked_reason = CASE WHEN NEW.to_status = 'blocked' THEN NEW.reason ELSE NULL END,
            attempt_count = attempt_count + CASE WHEN NEW.cause = 'claim' THEN 1 ELSE 0 END,
            updated_at = NEW.created_at WHERE ref = NEW.task_ref;
        END;
        INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (1, 'project_tasks', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      `);
      db.pragma('user_version = 1');
    }).immediate();
  }
  const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
  for (const name of REQUIRED_TABLES) if (!names.has(name)) throw new Error(`runtime.db missing table ${name}`);
  const migration = db.prepare('SELECT name FROM schema_migrations WHERE version = 1').get() as { name: string } | undefined;
  if (migration?.name !== 'project_tasks') throw new Error('runtime.db missing project task migration');
}

export interface TaskSpecInput {
  ref: string;
  /** Defaults to the body's first `# ` heading. */
  title?: string;
  bodyMarkdown: string;
  priority?: TaskPriority;
  requiredProvider?: TaskProvider | null;
  metadata?: Record<string, unknown>;
  dependsOn?: string[];
}

export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';
export type TaskProvider = 'codex' | 'claude' | 'gemini';
export type TaskSpecChanges = Partial<Omit<TaskSpecInput, 'ref'>>;

export interface ProjectTask {
  ref: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  requiredProvider: TaskProvider | null;
  attemptCount: number;
  blockedReason: string | null;
  bodyMarkdown: string;
  revision: number;
  contentHash: string;
  /** Parsed revision metadata; includes the indexed priority, provider and dependencies. */
  metadata: Record<string, unknown>;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskSpecRevision {
  taskRef: string;
  revision: number;
  contentHash: string;
  bodyMarkdown: string;
  title: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** Thrown when an edit names a revision that is no longer the latest. */
export class RevisionConflictError extends Error {
  readonly taskRef: string;
  readonly expectedRevision: number;
  readonly currentRevision: number;
  constructor(taskRef: string, expectedRevision: number, currentRevision: number) {
    super(`Task ${taskRef} revision conflict: expected revision ${expectedRevision}, current revision is ${currentRevision}`);
    this.name = 'RevisionConflictError';
    this.taskRef = taskRef;
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}

/** Indexed fields live in their own columns; they are copied into revision metadata so each revision is self-describing. */
const INDEXED_METADATA_KEYS = ['priority', 'required_provider', 'depends_on'] as const;

export function contentHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** First level-one heading, ignoring frontmatter. */
export function parseBodyTitle(body: string): string | null {
  const text = body.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, '');
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(text);
  return match ? match[1].trim() : null;
}

/** Checklist items under an "Acceptance criteria" heading. */
export function parseBodyAcceptanceCriteria(body: string): string[] {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => /^#{1,6}\s+acceptance criteria\s*$/i.test(line.trim()));
  if (start === -1) return [];
  const criteria: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    const item = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line);
    if (item) criteria.push(item[1]);
  }
  return criteria;
}

function normalizeDependencies(ref: string, dependsOn: readonly unknown[]): string[] {
  const unique = [...new Set(dependsOn)];
  for (const dependency of unique) {
    if (typeof dependency !== 'string' || !dependency.trim()) throw new Error('Task dependencies must be non-empty strings');
    if (dependency === ref) throw new Error(`Task ${ref} cannot depend on itself`);
  }
  return (unique as string[]).sort();
}

interface TaskRow {
  ref: string; title: string; status: TaskStatus; priority: TaskPriority; required_provider: TaskProvider | null;
  attempt_count: number; blocked_reason: string | null; created_at: string; updated_at: string;
  body_markdown: string; revision: number; content_hash: string; metadata_json: string;
}

const TASK_SELECT = `SELECT t.ref, t.title, t.status, t.priority, t.required_provider, t.attempt_count, t.blocked_reason,
  t.created_at, t.updated_at, r.body_markdown, r.revision, r.content_hash, r.metadata_json
  FROM tasks t JOIN task_spec_revisions r ON r.task_ref = t.ref
    AND r.revision = (SELECT MAX(revision) FROM task_spec_revisions WHERE task_ref = t.ref)`;

export class ProjectTaskStore {
  private readonly db: Database.Database;

  constructor(projectStateDir: string) {
    mkdirSync(projectStateDir, { recursive: true, mode: 0o700 });
    this.db = new Database(join(projectStateDir, 'runtime.db'));
    try {
      this.db.pragma('busy_timeout = 5000');
      migrateProjectTaskSchema(this.db);
      this.db.pragma('journal_mode = WAL');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  createTask(input: TaskSpecInput): ProjectTask {
    const title = input.title ?? parseBodyTitle(input.bodyMarkdown);
    if (!input.ref.trim() || !title?.trim()) throw new Error('Task ref and title are required');
    const now = new Date().toISOString();
    const dependsOn = normalizeDependencies(input.ref, input.dependsOn ?? []);
    const priority = input.priority ?? 'normal';
    const requiredProvider = input.requiredProvider ?? null;
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO tasks (ref, title, priority, required_provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.ref, title, priority, requiredProvider, now, now);
      this.insertRevision(input.ref, 1, { title, bodyMarkdown: input.bodyMarkdown, metadata: input.metadata ?? {}, priority, requiredProvider, dependsOn }, now);
      this.replaceDependencies(input.ref, dependsOn);
    }).immediate();
    return this.getTask(input.ref)!;
  }

  /**
   * Save an edit as a new immutable revision. `expectedRevision` must be the
   * latest revision, so concurrent editors cannot overwrite each other. An
   * edit that changes nothing returns the current revision unchanged.
   */
  reviseTask(ref: string, expectedRevision: number, changes: TaskSpecChanges): { task: ProjectTask; changed: boolean } {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('expected revision must be a positive integer');
    const changed = this.db.transaction(() => {
      const current = this.getTask(ref);
      if (!current) throw new Error(`Task not found: ${ref}`);
      if (current.revision !== expectedRevision) throw new RevisionConflictError(ref, expectedRevision, current.revision);
      const bodyMarkdown = changes.bodyMarkdown ?? current.bodyMarkdown;
      const title = changes.title ?? (changes.bodyMarkdown !== undefined ? parseBodyTitle(bodyMarkdown) : null) ?? current.title;
      if (!title.trim()) throw new Error('Task title is required');
      const baseMetadata = Object.fromEntries(Object.entries(current.metadata).filter(([key]) => !(INDEXED_METADATA_KEYS as readonly string[]).includes(key)));
      const metadata = changes.metadata ?? baseMetadata;
      const priority = changes.priority ?? current.priority;
      const requiredProvider = changes.requiredProvider !== undefined ? changes.requiredProvider : current.requiredProvider;
      const dependsOn = changes.dependsOn !== undefined ? normalizeDependencies(ref, changes.dependsOn) : current.dependsOn;
      const next = { title, bodyMarkdown, metadata, priority, requiredProvider, dependsOn };
      if (JSON.stringify(this.revisionMetadata(next)) === JSON.stringify(current.metadata)
        && title === current.title && bodyMarkdown === current.bodyMarkdown) return false;
      const now = new Date().toISOString();
      this.insertRevision(ref, current.revision + 1, next, now);
      this.db.prepare('UPDATE tasks SET title = ?, priority = ?, required_provider = ?, updated_at = ? WHERE ref = ?')
        .run(title, priority, requiredProvider, now, ref);
      this.replaceDependencies(ref, dependsOn);
      return true;
    }).immediate();
    return { task: this.getTask(ref)!, changed };
  }

  getTask(ref: string): ProjectTask | null {
    const row = this.db.prepare(`${TASK_SELECT} WHERE t.ref = ?`).get(ref) as TaskRow | undefined;
    return row ? this.toTask(row, this.dependencies(ref)) : null;
  }

  listTasks(): ProjectTask[] {
    const rows = this.db.prepare(`${TASK_SELECT} ORDER BY t.created_at, t.ref`).all() as TaskRow[];
    const dependencies = new Map<string, string[]>();
    for (const row of this.db.prepare('SELECT task_ref, depends_on_ref FROM task_dependencies ORDER BY depends_on_ref').all() as Array<{ task_ref: string; depends_on_ref: string }>) {
      dependencies.set(row.task_ref, [...(dependencies.get(row.task_ref) ?? []), row.depends_on_ref]);
    }
    return rows.map((row) => this.toTask(row, dependencies.get(row.ref) ?? []));
  }

  getRevision(ref: string, revision: number): TaskSpecRevision | null {
    const row = this.db.prepare('SELECT * FROM task_spec_revisions WHERE task_ref = ? AND revision = ?').get(ref, revision) as {
      task_ref: string; revision: number; content_hash: string; body_markdown: string; title: string; metadata_json: string; created_at: string;
    } | undefined;
    if (!row) return null;
    return {
      taskRef: row.task_ref, revision: row.revision, contentHash: row.content_hash, bodyMarkdown: row.body_markdown,
      title: row.title, metadata: JSON.parse(row.metadata_json) as Record<string, unknown>, createdAt: row.created_at,
    };
  }

  listRevisions(ref: string): Array<Omit<TaskSpecRevision, 'bodyMarkdown'>> {
    return (this.db.prepare('SELECT revision FROM task_spec_revisions WHERE task_ref = ? ORDER BY revision').all(ref) as Array<{ revision: number }>)
      .map(({ revision }) => {
        const { bodyMarkdown: _body, ...rest } = this.getRevision(ref, revision)!;
        return rest;
      });
  }

  /** Pin a new run to the task's latest revision (or an explicit one) and return that exact revision. */
  bindRun(runId: string, ref: string, agentId: string | null, revision?: number): TaskSpecRevision {
    return this.db.transaction(() => {
      const pinned = revision ?? this.getTask(ref)?.revision;
      if (pinned === undefined) throw new Error(`Task not found: ${ref}`);
      const now = new Date().toISOString();
      this.db.prepare("INSERT INTO task_runs (run_id, task_ref, spec_revision, agent_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'claimed', ?, ?)")
        .run(runId, ref, pinned, agentId, now, now);
      return this.getRevision(ref, pinned)!;
    }).immediate();
  }

  /** The revision a run was bound to when claimed; later edits never change it. */
  getRunSpec(runId: string): TaskSpecRevision | null {
    const run = this.db.prepare('SELECT task_ref, spec_revision FROM task_runs WHERE run_id = ?').get(runId) as { task_ref: string; spec_revision: number } | undefined;
    return run ? this.getRevision(run.task_ref, run.spec_revision) : null;
  }

  transition(ref: string, cause: TaskTransitionCause, to: TaskStatus, reason?: string, idempotencyKey?: string): void {
    const task = this.getTask(ref);
    if (!task) throw new Error(`Task not found: ${ref}`);
    this.db.prepare('INSERT INTO task_transitions (task_ref, from_status, to_status, cause, reason, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ref, task.status, to, cause, reason ?? null, idempotencyKey ?? null, new Date().toISOString());
  }

  withDatabase<T>(operation: (db: Database.Database) => T): T { return operation(this.db); }

  private revisionMetadata(spec: { metadata: Record<string, unknown>; priority: TaskPriority; requiredProvider: TaskProvider | null; dependsOn: string[] }): Record<string, unknown> {
    return { ...spec.metadata, priority: spec.priority, required_provider: spec.requiredProvider, depends_on: spec.dependsOn };
  }

  private insertRevision(ref: string, revision: number, spec: { title: string; bodyMarkdown: string; metadata: Record<string, unknown>; priority: TaskPriority; requiredProvider: TaskProvider | null; dependsOn: string[] }, now: string): void {
    this.db.prepare('INSERT INTO task_spec_revisions (task_ref, revision, content_hash, body_markdown, title, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ref, revision, contentHash(spec.bodyMarkdown), spec.bodyMarkdown, spec.title, JSON.stringify(this.revisionMetadata(spec)), now);
  }

  private replaceDependencies(ref: string, dependsOn: string[]): void {
    this.db.prepare('DELETE FROM task_dependencies WHERE task_ref = ?').run(ref);
    const insert = this.db.prepare('INSERT INTO task_dependencies (task_ref, depends_on_ref) VALUES (?, ?)');
    for (const dependency of dependsOn) insert.run(ref, dependency);
  }

  private dependencies(ref: string): string[] {
    return (this.db.prepare('SELECT depends_on_ref FROM task_dependencies WHERE task_ref = ? ORDER BY depends_on_ref').all(ref) as Array<{ depends_on_ref: string }>)
      .map((row) => row.depends_on_ref);
  }

  private toTask(row: TaskRow, dependsOn: string[]): ProjectTask {
    return {
      ref: row.ref, title: row.title, status: row.status, priority: row.priority, requiredProvider: row.required_provider,
      attemptCount: row.attempt_count, blockedReason: row.blocked_reason, bodyMarkdown: row.body_markdown,
      revision: row.revision, contentHash: row.content_hash, metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
      dependsOn, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
}
