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
  title: string;
  bodyMarkdown: string;
  priority?: 'low' | 'normal' | 'high' | 'critical';
  requiredProvider?: 'codex' | 'claude' | 'gemini' | null;
  metadata?: Record<string, unknown>;
  dependsOn?: string[];
}

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

  createTask(input: TaskSpecInput): void {
    if (!input.ref.trim() || !input.title.trim()) throw new Error('Task ref and title are required');
    const now = new Date().toISOString();
    const body = input.bodyMarkdown;
    const hash = createHash('sha256').update(body).digest('hex');
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO tasks (ref, title, priority, required_provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.ref, input.title, input.priority ?? 'normal', input.requiredProvider ?? null, now, now);
      this.db.prepare('INSERT INTO task_spec_revisions (task_ref, revision, content_hash, body_markdown, title, metadata_json, created_at) VALUES (?, 1, ?, ?, ?, ?, ?)')
        .run(input.ref, hash, body, input.title, JSON.stringify(input.metadata ?? {}), now);
      for (const dependency of new Set(input.dependsOn ?? [])) {
        this.db.prepare('INSERT INTO task_dependencies (task_ref, depends_on_ref) VALUES (?, ?)').run(input.ref, dependency);
      }
    }).immediate();
  }

  getTask(ref: string): { ref: string; title: string; status: TaskStatus; attemptCount: number; blockedReason: string | null; bodyMarkdown: string; revision: number; contentHash: string; metadata: Record<string, unknown>; dependsOn: string[] } | null {
    const row = this.db.prepare(`SELECT t.ref, t.title, t.status, t.attempt_count, t.blocked_reason,
      r.body_markdown, r.revision, r.content_hash, r.metadata_json
      FROM tasks t JOIN task_spec_revisions r ON r.task_ref = t.ref
      WHERE t.ref = ? ORDER BY r.revision DESC LIMIT 1`).get(ref) as {
      ref: string; title: string; status: TaskStatus; attempt_count: number; blocked_reason: string | null;
      body_markdown: string; revision: number; content_hash: string; metadata_json: string;
    } | undefined;
    if (!row) return null;
    const dependencies = this.db.prepare('SELECT depends_on_ref FROM task_dependencies WHERE task_ref = ? ORDER BY depends_on_ref').all(ref) as Array<{ depends_on_ref: string }>;
    return { ref: row.ref, title: row.title, status: row.status, attemptCount: row.attempt_count, blockedReason: row.blocked_reason, bodyMarkdown: row.body_markdown, revision: row.revision, contentHash: row.content_hash, metadata: JSON.parse(row.metadata_json) as Record<string, unknown>, dependsOn: dependencies.map((item) => item.depends_on_ref) };
  }

  transition(ref: string, cause: TaskTransitionCause, to: TaskStatus, reason?: string, idempotencyKey?: string): void {
    const task = this.getTask(ref);
    if (!task) throw new Error(`Task not found: ${ref}`);
    this.db.prepare('INSERT INTO task_transitions (task_ref, from_status, to_status, cause, reason, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ref, task.status, to, cause, reason ?? null, idempotencyKey ?? null, new Date().toISOString());
  }

  withDatabase<T>(operation: (db: Database.Database) => T): T { return operation(this.db); }
}
