import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { TASK_REF_RE, TASK_TYPES } from './constants.ts';
import { parsePlan } from './planDocs.ts';
import { createProjectTask, featureRefOf, requireProjectTaskStore, reviseProjectTask, TaskInputError, withTaskAuthoringBatch } from './projectTasks.ts';
import type { ProjectTask } from './projectTaskStore.ts';

/**
 * Explicit, one-way Markdown interface for project tasks and plans. Import
 * creates a revision from a caller-chosen file; export renders SQLite content
 * to a caller-chosen path. Nothing is watched or synced back, and lifecycle
 * state never travels through Markdown.
 */

/** Runtime-owned fields that ordinary imports ignore (or reject with `strict`). */
export const LIFECYCLE_FIELDS = ['status', 'attempt_count', 'blocked_reason', 'requeue_eligible_after', 'owner', 'planning_state', 'delegated_by'] as const;

/** Fields written to an export but only used diagnostically (or as the edit base) on import. */
const EXPORT_ONLY_FIELDS = ['spec_revision', 'content_hash', 'exported_at'] as const;

const SCALAR_FIELDS = ['ref', 'feature', 'epic', 'title', 'priority', 'required_provider', 'review_level', 'merge_strategy', 'task_type', 'model'] as const;
const LIST_FIELDS = ['depends_on', 'required_capabilities'] as const;

type Frontmatter = Record<string, string | string[]>;

/** Double-quoted scalars are JSON strings (what export writes); single quotes are stripped. */
function parseScalar(value: string): string {
  if (/^".*"$/.test(value)) {
    try { return JSON.parse(value) as string; } catch { return value.slice(1, -1); }
  }
  return value.replace(/^'(.*)'$/, '$1');
}

/** Quote a scalar whenever plain output would not parse back to the same string. */
export function formatScalar(value: string): string {
  return /^['"\s]|['"\s]$|^$|^\[|\s#|^#/.test(value) ? JSON.stringify(value) : value;
}

function fileSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The small YAML subset used by task specs: `key: value`, `key: []`, and `key:` followed by `  - item` lines. */
export function parseFrontmatter(text: string, source: string): { frontmatter: Frontmatter; body: string } | null {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  const frontmatter: Frontmatter = {};
  let listKey: string | null = null;
  for (const raw of match[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.+?)\s*$/.exec(raw);
    if (item) {
      if (!listKey) throw new TaskInputError(`${source}: list item outside a list field: ${raw.trim()}`);
      (frontmatter[listKey] as string[]).push(parseScalar(item[1]));
      continue;
    }
    const field = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(raw);
    if (!field) throw new TaskInputError(`${source}: unsupported frontmatter line: ${raw.trim()}`);
    const [, key, value] = field;
    if (key in frontmatter) throw new TaskInputError(`${source}: duplicate frontmatter field: ${key}`);
    listKey = null;
    if (value === '') { frontmatter[key] = []; listKey = key; }
    else if (value === '[]') frontmatter[key] = [];
    else frontmatter[key] = parseScalar(value);
  }
  return { frontmatter, body: text.slice(match[0].length).replace(/^\r?\n/, '') };
}

function humanize(slug: string): string {
  return slug.split('-').filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
}

/** Legacy `# Task N — Title` headings keep their title; otherwise the first `# ` heading, else the slug. */
function titleFromBody(body: string, ref: string): string {
  const legacy = /^#\s+Task\s+\d+\s+[—-]\s+(.+?)\s*$/m.exec(body)?.[1];
  if (legacy) return legacy;
  return /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1] ?? humanize(ref.split('/')[1] ?? ref);
}

export interface ParsedTaskMarkdown {
  sourcePath: string;
  fileSha256: string;
  ref: string;
  feature: string;
  title: string;
  bodyMarkdown: string;
  fields: Record<string, unknown>;
  /** The revision an exported file was based on; used as the edit's expected revision. */
  baseRevision: number | null;
  ignoredFields: string[];
  /** A legacy `status:` value; never applied, but a new task cannot start as todo from a finished spec. */
  legacyStatus: string | null;
}

export function parseTaskMarkdown(text: string, sourcePath: string, { strict = false }: { strict?: boolean } = {}): ParsedTaskMarkdown | null {
  const parsed = parseFrontmatter(text, sourcePath);
  if (!parsed || typeof parsed.frontmatter.ref !== 'string') return null;
  const { frontmatter, body } = parsed;
  const ref = frontmatter.ref as string;
  if (!TASK_REF_RE.test(ref)) throw new TaskInputError(`${sourcePath}: invalid task ref: ${ref}`);
  const feature = typeof frontmatter.feature === 'string' ? frontmatter.feature
    : typeof frontmatter.epic === 'string' ? frontmatter.epic : ref.split('/')[0];
  if (ref.split('/')[0] !== feature) throw new TaskInputError(`${sourcePath}: ref ${ref} does not belong to feature ${feature}`);
  const known = new Set<string>([...SCALAR_FIELDS, ...LIST_FIELDS, ...EXPORT_ONLY_FIELDS, ...LIFECYCLE_FIELDS]);
  const unknown = Object.keys(frontmatter).filter((key) => !known.has(key));
  if (unknown.length > 0) throw new TaskInputError(`${sourcePath}: unsupported frontmatter field(s): ${unknown.join(', ')}`);
  const ignoredFields: string[] = LIFECYCLE_FIELDS.filter((key) => key in frontmatter);
  if (strict && ignoredFields.length > 0) {
    throw new TaskInputError(`${sourcePath}: lifecycle field(s) ${ignoredFields.join(', ')} cannot be imported; runtime status is owned by project SQLite`);
  }
  const fields: Record<string, unknown> = {};
  // Older specs used free-form task types the runtime never read; they are not imported.
  if (typeof frontmatter.task_type === 'string' && !TASK_TYPES.includes(frontmatter.task_type)) {
    delete frontmatter.task_type;
    ignoredFields.push('task_type');
  }
  for (const key of ['priority', 'required_provider', 'review_level', 'merge_strategy', 'task_type', 'model'] as const) {
    if (key in frontmatter) {
      if (typeof frontmatter[key] !== 'string') throw new TaskInputError(`${sourcePath}: ${key} must be a scalar`);
      fields[key] = frontmatter[key];
    }
  }
  for (const key of LIST_FIELDS) {
    if (key in frontmatter) {
      if (!Array.isArray(frontmatter[key])) throw new TaskInputError(`${sourcePath}: ${key} must be a list`);
      fields[key] = frontmatter[key];
    }
  }
  const revision = frontmatter.spec_revision;
  if (revision !== undefined && (typeof revision !== 'string' || !/^[1-9]\d*$/.test(revision))) {
    throw new TaskInputError(`${sourcePath}: spec_revision must be a positive integer`);
  }
  return {
    sourcePath, fileSha256: fileSha256(text), ref, feature,
    title: typeof frontmatter.title === 'string' && frontmatter.title.trim() ? frontmatter.title : titleFromBody(body, ref),
    bodyMarkdown: body, fields,
    baseRevision: revision === undefined ? null : Number(revision), ignoredFields,
    legacyStatus: typeof frontmatter.status === 'string' ? frontmatter.status : null,
  };
}

// Archived specs, as in backlog sync.
const LEGACY_DIR_RE = /^legacy[\\/]/;

function markdownFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return (readdirSync(path, { recursive: true }) as string[])
    .filter((relative) => relative.endsWith('.md') && !LEGACY_DIR_RE.test(relative))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((relative) => join(path, relative));
}

export interface TaskImportResult {
  path: string;
  ref: string;
  action: 'created' | 'revised' | 'unchanged';
  revision: number;
  ignored_fields: string[];
}

export interface TaskMarkdownSource { path: string; text: string }

/**
 * Read the specs an import names, in the caller's process: a sandboxed client
 * sends their contents to the coordinator, which never opens a client's path.
 */
export function readTaskMarkdownSources(path: string): { sources: TaskMarkdownSource[]; skipped: string[] } {
  const source = resolve(path);
  if (!existsSync(source)) throw new TaskInputError(`Import path not found: ${source}`);
  const skipped: string[] = [];
  const sources: TaskMarkdownSource[] = [];
  const directory = statSync(source).isDirectory();
  for (const file of markdownFiles(source)) {
    const text = readFileSync(file, 'utf8');
    // A directory may hold templates and notes; only files naming a valid task ref are specs there.
    if (directory) {
      const ref = /^---[ \t]*\r?\n[\s\S]*?^ref:[ \t]*(\S+)/m.exec(text)?.[1];
      if (!ref || !TASK_REF_RE.test(ref.replace(/^(['"])(.*)\1$/, '$2'))) { skipped.push(file); continue; }
    }
    sources.push({ path: file, text });
  }
  return { sources, skipped };
}

/**
 * Import task specs from a file or directory in one transaction, so any
 * failing file leaves the project unchanged. In a directory, Markdown without
 * a valid `ref` (templates, notes) and `legacy/` are skipped; a named file
 * must be a spec.
 * A new ref creates revision 1. An existing ref gets a new revision; when the
 * file came from an export, its `spec_revision` is the expected revision, so
 * an edit to a stale export fails instead of overwriting newer work.
 */
export function importTaskMarkdown(stateDir: string, path: string, options: { strict?: boolean; actorId?: string } = {}): { imported: TaskImportResult[]; skipped: string[] } {
  const { sources, skipped } = readTaskMarkdownSources(path);
  return { imported: importTaskMarkdownSources(stateDir, sources, options), skipped };
}

/** Apply already-read specs (see importTaskMarkdown); each source must be a spec. */
export function importTaskMarkdownSources(stateDir: string, sources: TaskMarkdownSource[], { strict = false, actorId = 'human' }: { strict?: boolean; actorId?: string } = {}): TaskImportResult[] {
  const store = requireProjectTaskStore(stateDir);
  const specs: ParsedTaskMarkdown[] = [];
  for (const { path: file, text } of sources) {
    const spec = parseTaskMarkdown(text, file, { strict });
    if (!spec) throw new TaskInputError(`${file} is not a task spec: missing ref frontmatter`);
    specs.push(spec);
  }
  const refs = new Set<string>();
  for (const spec of specs) {
    if (refs.has(spec.ref)) throw new TaskInputError(`Duplicate task ref in import: ${spec.ref}`);
    refs.add(spec.ref);
    if (!store.getTask(spec.ref) && spec.legacyStatus && spec.legacyStatus !== 'todo') {
      throw new TaskInputError(`${spec.sourcePath}: new task ${spec.ref} has status ${spec.legacyStatus}; an ordinary import would start it as todo. `
        + 'Remove the status field to import it as new work, or migrate the installation to carry its runtime status.');
    }
  }

  // One transaction: a failure in any file leaves the project unchanged.
  return withTaskAuthoringBatch(stateDir, () => specs.map((spec): TaskImportResult => {
    const current = store.getTask(spec.ref);
    let task: ProjectTask;
    let action: TaskImportResult['action'];
    if (!current) {
      task = createProjectTask(stateDir, {
        feature: spec.feature, ref: spec.ref.split('/')[1], title: spec.title, body_markdown: spec.bodyMarkdown, ...spec.fields,
      }, actorId);
      action = 'created';
    } else {
      // The file is the whole definition: a field it omits is cleared, not kept.
      const result = reviseProjectTask(stateDir, spec.ref, spec.baseRevision ?? current.revision, {
        title: spec.title, body_markdown: spec.bodyMarkdown,
        priority: 'normal', required_provider: null, review_level: null, merge_strategy: null, model: null,
        task_type: 'implementation', depends_on: [], required_capabilities: [],
        ...spec.fields,
      }, actorId);
      task = result.task;
      action = result.changed ? 'revised' : 'unchanged';
    }
    store.recordImport(spec.ref, task.revision, spec.sourcePath, spec.fileSha256);
    return { path: spec.sourcePath, ref: spec.ref, action, revision: task.revision, ignored_fields: spec.ignoredFields };
  }));
}

function yamlList(key: string, values: unknown): string[] {
  const items = Array.isArray(values) ? values as unknown[] : [];
  // An empty list is written so that removing every item is expressible in an edited export.
  return items.length === 0 ? [`${key}: []`] : [`${key}:`, ...items.map((value) => `  - ${formatScalar(String(value))}`)];
}

/** Readable Markdown for one task: definition metadata as frontmatter, then the stored body. No status. */
export function renderTaskMarkdown(task: ProjectTask): string {
  const lines = ['---', `ref: ${task.ref}`, `feature: ${featureRefOf(task)}`, `title: ${formatScalar(task.title)}`];
  for (const key of ['task_type', 'review_level', 'merge_strategy', 'model'] as const) {
    const value = task.metadata[key];
    if (typeof value === 'string') lines.push(`${key}: ${formatScalar(value)}`);
  }
  lines.push(`priority: ${task.priority}`);
  if (task.requiredProvider) lines.push(`required_provider: ${task.requiredProvider}`);
  lines.push(...yamlList('depends_on', task.dependsOn), ...yamlList('required_capabilities', task.metadata.required_capabilities));
  lines.push(`spec_revision: ${task.revision}`, `content_hash: ${task.contentHash}`, '---', '');
  return `${lines.join('\n')}${task.bodyMarkdown}`;
}

/**
 * Export tasks to a caller-chosen path. A `.md` destination receives exactly
 * one task; any other destination is a directory receiving
 * `<feature>/<slug>.md` per task.
 */
export function exportTaskMarkdown(stateDir: string, destination: string, { refs }: { refs?: string[] } = {}): Array<{ ref: string; path: string; revision: number }> {
  const store = requireProjectTaskStore(stateDir);
  const tasks = refs?.length
    ? refs.map((ref) => store.getTask(ref) ?? (() => { throw new TaskInputError(`Task not found: ${ref}`); })())
    : store.listTasks();
  const target = resolve(destination);
  const single = target.endsWith('.md');
  if (single && tasks.length !== 1) throw new TaskInputError(`A .md destination needs exactly one task; got ${tasks.length}`);
  return tasks.map((task) => {
    const path = single ? target : join(target, featureRefOf(task), `${task.ref.split('/')[1]}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderTaskMarkdown(task));
    return { ref: task.ref, path, revision: task.revision };
  });
}

// ── Plans ─────────────────────────────────────────────────────────────────

/** Store a validated plan file's content and metadata in project state. */
export function importPlanMarkdown(stateDir: string, path: string): { plan_id: number; changed: boolean } {
  const store = requireProjectTaskStore(stateDir);
  const source = resolve(path);
  const plan = parsePlan(source);
  const changed = store.savePlan({
    planId: plan.planId, name: plan.name, title: plan.title, bodyMarkdown: readFileSync(source, 'utf8'),
    metadata: { created_at: plan.createdAt, updated_at: plan.updatedAt, derived_task_refs: plan.derivedTaskRefs, steps: plan.steps.map((step) => step.number) },
    sourcePath: source,
  });
  return { plan_id: plan.planId, changed };
}

/** Write a stored plan as readable Markdown; a directory destination receives `<plan_id>-<name>.md`. */
export function exportPlanMarkdown(stateDir: string, planId: number, destination: string): string {
  const plan = requireProjectTaskStore(stateDir).getPlan(planId);
  if (!plan) throw new TaskInputError(`Plan not found: ${planId}`);
  const target = resolve(destination);
  const path = target.endsWith('.md') ? target : join(target, `${plan.planId}-${plan.name}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, plan.bodyMarkdown);
  return path;
}
