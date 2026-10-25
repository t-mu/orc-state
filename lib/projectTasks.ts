import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './atomicWrite.ts';
import { AGENT_ID_RE, TASK_PRIORITIES, TASK_REF_RE, TASK_TYPES } from './constants.ts';
import { appendSequencedEvent } from './eventLog.ts';
import { logger } from './logger.ts';
import {
  parseBodyAcceptanceCriteria, ProjectTaskStore,
  type ProjectTask, type TaskPriority, type TaskProvider, type TaskSpecChanges,
} from './projectTaskStore.ts';
import { isSupportedProvider } from './providers.ts';
import type { Backlog, Feature, Task } from '../types/backlog.ts';

/**
 * Project task authority. A state directory whose `runtime.db` exists is a
 * project state directory: its task definitions live in SQLite and
 * `backlog.json` is a read-only projection. Other state directories keep the
 * legacy Markdown-synced backlog until they are migrated.
 */
const stores = new Map<string, ProjectTaskStore>();

export function isProjectStateDir(stateDir: string): boolean {
  return existsSync(join(stateDir, 'runtime.db'));
}

/** The cached store for a project state directory, or null for a legacy one. */
export function projectTaskStoreFor(stateDir: string): ProjectTaskStore | null {
  const cached = stores.get(stateDir);
  if (cached?.withDatabase((db) => db.open)) return cached;
  stores.delete(stateDir);
  if (!isProjectStateDir(stateDir)) return null;
  const store = new ProjectTaskStore(stateDir);
  stores.set(stateDir, store);
  return store;
}

/** Create the project task database, making this state directory SQLite-authoritative. */
export function initProjectTaskStore(stateDir: string): ProjectTaskStore {
  return projectTaskStoreFor(stateDir) ?? (() => {
    const store = new ProjectTaskStore(stateDir);
    stores.set(stateDir, store);
    refreshBacklogProjection(stateDir);
    return store;
  })();
}

export function closeProjectTaskStores(): void {
  for (const store of stores.values()) {
    try { store.close(); } catch { /* best-effort */ }
  }
  stores.clear();
}

/** Authoring fields accepted only for project tasks; legacy handlers reject them. */
export const PROJECT_ONLY_TASK_FIELDS = ['body_markdown', 'expected_revision', 'review_level', 'merge_strategy'] as const;

/** Definition fields kept in revision metadata, beyond the indexed priority/provider/dependencies. */
const DEFINITION_FIELDS = ['feature', 'task_type', 'description', 'acceptance_criteria', 'review_level', 'merge_strategy', 'required_capabilities', 'model'] as const;
/** Dispatch fields set when a task is registered; they do not create revisions. */
const DISPATCH_FIELDS = ['owner', 'planning_state', 'delegated_by'] as const;

export function featureRefOf(task: Pick<ProjectTask, 'ref' | 'metadata'>): string {
  return typeof task.metadata.feature === 'string' ? task.metadata.feature : task.ref.split('/')[0];
}

export function projectTaskToBacklogTask(task: ProjectTask): Task {
  const projected: Record<string, unknown> = {
    ref: task.ref,
    title: task.title,
    status: task.status,
    priority: task.priority,
    task_type: task.metadata.task_type ?? 'implementation',
    spec_revision: task.revision,
    attempt_count: task.attemptCount,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
  if (task.requiredProvider) projected.required_provider = task.requiredProvider;
  if (task.dependsOn.length > 0) projected.depends_on = task.dependsOn;
  if (task.blockedReason) projected.blocked_reason = task.blockedReason;
  for (const field of [...DEFINITION_FIELDS, ...DISPATCH_FIELDS]) {
    if (field === 'feature' || field === 'task_type') continue;
    const value = task.metadata[field];
    if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) projected[field] = value;
  }
  return projected as unknown as Task;
}

/** The legacy backlog shape, derived from project SQLite. */
export function readProjectBacklog(store: ProjectTaskStore): Backlog {
  const features = new Map<string, Feature>();
  for (const task of store.listTasks()) {
    const ref = featureRefOf(task);
    const feature = features.get(ref) ?? { ref, title: ref, tasks: [] };
    feature.tasks.push(projectTaskToBacklogTask(task));
    features.set(ref, feature);
  }
  return { version: '1', features: [...features.values()] };
}

/** Rewrite the read-only backlog.json projection. A failed write never undoes SQLite. */
export function refreshBacklogProjection(stateDir: string): void {
  const store = projectTaskStoreFor(stateDir);
  if (!store) return;
  try {
    atomicWriteJson(join(stateDir, 'backlog.json'), readProjectBacklog(store));
  } catch (error) {
    logger.error('[projectTasks] backlog.json projection failed; SQLite remains authoritative:', error);
  }
}

export function requireProjectTaskStore(stateDir: string): ProjectTaskStore {
  const store = projectTaskStoreFor(stateDir);
  if (!store) throw new Error(`Not a project state directory (no runtime.db): ${stateDir}`);
  return store;
}

// ── Storage-neutral authoring API (CLI, MCP and control API) ────────────────

let pendingNotifications: Array<() => void> | null = null;

/** Emit an authoring event and refresh the projection, or defer both until the enclosing batch commits. */
function notify(stateDir: string, emit: () => void): void {
  if (pendingNotifications) {
    pendingNotifications.push(emit);
    return;
  }
  emit();
  refreshBacklogProjection(stateDir);
}

/**
 * Run several authoring calls as one SQLite transaction: either every task
 * change commits or none does, and events are emitted only after the commit.
 */
export function withTaskAuthoringBatch<T>(stateDir: string, operation: () => T): T {
  if (pendingNotifications) throw new Error('Task authoring batches cannot be nested');
  const store = requireProjectTaskStore(stateDir);
  pendingNotifications = [];
  let emits: Array<() => void>;
  let result: T;
  try {
    result = store.withDatabase((db) => db.transaction(operation).immediate());
    emits = pendingNotifications;
  } finally {
    pendingNotifications = null;
  }
  for (const emit of emits) emit();
  if (emits.length > 0) refreshBacklogProjection(stateDir);
  return result;
}

/** A rejected caller input, as opposed to a storage failure. */
export class TaskInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskInputError';
  }
}

export interface TaskAuthoringInput {
  feature?: unknown;
  ref?: unknown;
  title?: unknown;
  body_markdown?: unknown;
  task_type?: unknown;
  priority?: unknown;
  description?: unknown;
  acceptance_criteria?: unknown;
  depends_on?: unknown;
  required_capabilities?: unknown;
  required_provider?: unknown;
  model?: unknown;
  review_level?: unknown;
  merge_strategy?: unknown;
  owner?: unknown;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new TaskInputError(`${field} must be a string`);
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new TaskInputError(`${field} must be an array of strings`);
  return value as string[];
}

function optionalChoice(value: unknown, field: string, choices: readonly string[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !choices.includes(value)) throw new TaskInputError(`Invalid ${field}: ${JSON.stringify(value)}`);
  return value;
}

function validateDependencyRefs(dependsOn: string[] | undefined): void {
  for (const dependency of dependsOn ?? []) {
    if (!TASK_REF_RE.test(dependency)) throw new TaskInputError(`Invalid depends_on ref: ${dependency}`);
  }
}

/** A readable default body for a task created without Markdown. */
export function renderTaskBody(title: string, description?: string, acceptanceCriteria: string[] = []): string {
  const parts = [`# ${title}`];
  if (description?.trim()) parts.push(description.trim());
  if (acceptanceCriteria.length > 0) parts.push(`## Acceptance criteria\n\n${acceptanceCriteria.map((item) => `- [ ] ${item}`).join('\n')}`);
  return `${parts.join('\n\n')}\n`;
}

function definitionMetadata(input: TaskAuthoringInput, base: Record<string, unknown>, bodyMarkdown: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...base };
  const set = (key: string, value: unknown) => {
    if (value === undefined) return;
    // Null clears a field; an empty list is stored as absent so both spellings are one revision.
    if (value === null || (Array.isArray(value) && value.length === 0)) delete metadata[key];
    else metadata[key] = value;
  };
  set('task_type', optionalChoice(input.task_type, 'task_type', TASK_TYPES));
  set('description', input.description === null ? null : optionalString(input.description, 'description'));
  set('acceptance_criteria', optionalStringArray(input.acceptance_criteria, 'acceptance_criteria'));
  set('required_capabilities', optionalStringArray(input.required_capabilities, 'required_capabilities'));
  set('model', input.model === null ? null : optionalString(input.model, 'model'));
  set('review_level', input.review_level === null ? null : optionalChoice(input.review_level, 'review_level', ['none', 'light', 'full']));
  set('merge_strategy', input.merge_strategy === null ? null : optionalChoice(input.merge_strategy, 'merge_strategy', ['direct', 'pr']));
  // Parsed from the body when the caller does not state them explicitly.
  if (input.acceptance_criteria === undefined && input.body_markdown !== undefined) {
    const parsed = parseBodyAcceptanceCriteria(bodyMarkdown);
    if (parsed.length > 0) metadata.acceptance_criteria = parsed;
    else delete metadata.acceptance_criteria;
  }
  return metadata;
}

function assertActor(actorId: string): void {
  if (!AGENT_ID_RE.test(actorId)) throw new TaskInputError(`Invalid actor-id: ${actorId}. Must match ^[a-z0-9][a-z0-9-]*$.`);
}

/** Create a database-only task. No Markdown file or repo-local artifact is read or written. */
export function createProjectTask(stateDir: string, input: TaskAuthoringInput, actorId = 'human'): ProjectTask {
  assertActor(actorId);
  const store = requireProjectTaskStore(stateDir);
  const feature = optionalString(input.feature, 'feature')?.trim() || 'general';
  const description = optionalString(input.description, 'description');
  const acceptanceCriteria = optionalStringArray(input.acceptance_criteria, 'acceptance_criteria');
  const explicitTitle = optionalString(input.title, 'title');
  const explicitBody = optionalString(input.body_markdown, 'body_markdown');
  if (!explicitTitle && !explicitBody) throw new TaskInputError('title or body_markdown is required');
  const bodyMarkdown = explicitBody ?? renderTaskBody(explicitTitle!, description, acceptanceCriteria);
  const slug = optionalString(input.ref, 'ref') ?? slugify(explicitTitle ?? bodyMarkdown.split('\n').find((line) => line.startsWith('# '))?.slice(2) ?? '');
  const ref = `${feature}/${slug}`;
  if (!slug || !TASK_REF_RE.test(ref)) throw new TaskInputError(`Invalid task ref: ${ref}`);
  const dependsOn = optionalStringArray(input.depends_on, 'depends_on');
  validateDependencyRefs(dependsOn);
  const priority = optionalChoice(input.priority, 'priority', TASK_PRIORITIES) as TaskPriority | undefined;
  const requiredProvider = input.required_provider == null ? null : input.required_provider;
  if (requiredProvider !== null && !isSupportedProvider(requiredProvider)) throw new TaskInputError(`Invalid required_provider: ${JSON.stringify(requiredProvider)}. Must be codex, claude, or gemini.`);
  const owner = optionalString(input.owner, 'owner');
  if (owner !== undefined && !AGENT_ID_RE.test(owner)) throw new TaskInputError(`Invalid owner: ${owner}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  if (store.getTask(ref)) throw new TaskInputError(`Task already exists: ${ref}`);

  const metadata = definitionMetadata(input, { feature, task_type: 'implementation', planning_state: 'ready_for_dispatch', delegated_by: actorId }, bodyMarkdown);
  // A body rendered from fields is re-rendered when those fields are edited.
  if (!explicitBody) metadata.body_source = 'rendered';
  if (owner) metadata.owner = owner;
  const task = store.createTask({
    ref, ...(explicitTitle ? { title: explicitTitle } : {}), bodyMarkdown, metadata,
    ...(priority ? { priority } : {}), requiredProvider: requiredProvider as TaskProvider | null, dependsOn: dependsOn ?? [],
  });
  notify(stateDir, () => appendSequencedEvent(stateDir, {
    ts: task.createdAt, event: 'task_added',
    actor_type: actorId === 'human' ? 'human' : 'agent', actor_id: actorId, task_ref: ref,
    payload: { title: task.title, task_type: metadata.task_type, feature_ref: feature, spec_revision: task.revision, content_hash: task.contentHash },
  }));
  return task;
}

/** Fields an edit may change. Lifecycle status is never editable here. */
const REVISABLE_FIELDS = new Set(['title', 'body_markdown', 'task_type', 'priority', 'description', 'acceptance_criteria', 'depends_on', 'required_capabilities', 'required_provider', 'model', 'review_level', 'merge_strategy']);

/** Save an edit as a new immutable revision, failing if `expectedRevision` is stale. */
export function reviseProjectTask(
  stateDir: string,
  ref: string,
  expectedRevision: unknown,
  input: TaskAuthoringInput & Record<string, unknown>,
  actorId = 'human',
): { task: ProjectTask; changed: boolean } {
  assertActor(actorId);
  const store = requireProjectTaskStore(stateDir);
  if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision)) {
    throw new TaskInputError('expected_revision is required for project task edits');
  }
  const rejected = Object.keys(input).filter((key) => input[key] !== undefined && !REVISABLE_FIELDS.has(key));
  if (rejected.length > 0) throw new TaskInputError(`Task edits cannot change: ${rejected.join(', ')}`);
  const current = store.getTask(ref);
  if (!current) throw new TaskInputError(`Task not found: ${ref}`);
  const bodyMarkdown = optionalString(input.body_markdown, 'body_markdown');
  const dependsOn = input.depends_on === null ? [] : optionalStringArray(input.depends_on, 'depends_on');
  validateDependencyRefs(dependsOn);
  const priority = optionalChoice(input.priority, 'priority', TASK_PRIORITIES) as TaskPriority | undefined;
  if (input.required_provider != null && !isSupportedProvider(input.required_provider)) {
    throw new TaskInputError(`Invalid required_provider: ${JSON.stringify(input.required_provider)}. Must be codex, claude, or gemini.`);
  }
  const { priority: _p, required_provider: _r, depends_on: _d, ...baseMetadata } = current.metadata;
  const metadata = definitionMetadata(input, baseMetadata, bodyMarkdown ?? current.bodyMarkdown);
  const title = optionalString(input.title, 'title');
  let nextBody = bodyMarkdown;
  if (bodyMarkdown !== undefined && bodyMarkdown !== current.bodyMarkdown) delete metadata.body_source;
  else if (bodyMarkdown === undefined && metadata.body_source === 'rendered') {
    nextBody = renderTaskBody(title ?? current.title,
      typeof metadata.description === 'string' ? metadata.description : undefined,
      Array.isArray(metadata.acceptance_criteria) ? metadata.acceptance_criteria as string[] : []);
  }
  const changes: TaskSpecChanges = {
    metadata,
    ...(title !== undefined ? { title } : {}),
    ...(nextBody !== undefined ? { bodyMarkdown: nextBody } : {}),
    ...(priority ? { priority } : {}),
    ...(input.required_provider !== undefined ? { requiredProvider: (input.required_provider ?? null) as TaskProvider | null } : {}),
    ...(dependsOn !== undefined ? { dependsOn } : {}),
  };
  const result = store.reviseTask(ref, expectedRevision, changes);
  if (result.changed) {
    notify(stateDir, () => appendSequencedEvent(stateDir, {
      ts: result.task.updatedAt, event: 'task_updated',
      actor_type: actorId === 'human' ? 'human' : 'agent', actor_id: actorId, task_ref: ref,
      payload: {
        status: result.task.status,
        fields: Object.keys(input).filter((key) => input[key] !== undefined),
        spec_revision: result.task.revision, previous_revision: expectedRevision, content_hash: result.task.contentHash,
      },
    }));
  }
  return result;
}

/** API view of a project task, including the revision an editor must pass back. */
export function describeProjectTask(task: ProjectTask): Task & { feature_ref: string; content_hash: string; body_markdown: string } {
  return {
    ...projectTaskToBacklogTask(task),
    feature_ref: featureRefOf(task),
    content_hash: task.contentHash,
    body_markdown: task.bodyMarkdown,
  };
}
