/**
 * Claude Code command hook for orc workers.
 *
 * Usage: node orc-hook.(ts|js) <permission|tool|todo> <events-file>
 *
 * Claude Code passes the hook payload as JSON on stdin. The script appends at
 * most one NDJSON record to <events-file> (drained by the coordinator, see
 * lib/hookEventBus.ts) and always exits 0, even on bad input: command hooks
 * are synchronous, so a failure or a slow path here stalls the worker's tool
 * call. It imports only node: built-ins to keep startup small.
 *
 * Records never carry full tool inputs or outputs: `tool` records hold a
 * short `brief` (≤ 80 chars) plus, for `Agent`/`Task`, the `subagent_type`;
 * `activity` records the current to-do label.
 */
import { appendFileSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRIEF_MAX = 80;
const BASH_BRIEF_MAX = 60;
const LABEL_MAX = 200;
/** Cap on remembered task labels so the sidecar file stays small. */
const MAX_REMEMBERED_TASKS = 200;

type Payload = Record<string, unknown>;
export type HookRecord = Record<string, unknown>;
export type TaskLabels = Record<string, string>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function obj(value: unknown): Payload {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Payload : {};
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function relPath(path: string, cwd: string): string {
  if (!path) return '';
  if (!cwd || !isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Short, secret-free summary of a tool call. Unknown tools get an empty brief. */
export function toolBrief(tool: string, input: Payload, cwd: string): string {
  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'Read':
      return clip(relPath(str(input.file_path), cwd), BRIEF_MAX);
    case 'NotebookEdit':
      return clip(relPath(str(input.notebook_path) || str(input.file_path), cwd), BRIEF_MAX);
    case 'Bash':
      return clip(str(input.command), BASH_BRIEF_MAX);
    case 'Grep':
    case 'Glob':
      return clip(str(input.pattern), BRIEF_MAX);
    case 'Agent':
    case 'Task':
      return clip(str(input.description) || str(input.subagent_type), BRIEF_MAX);
    case 'WebFetch':
      return clip(host(str(input.url)), BRIEF_MAX);
    case 'WebSearch':
      return clip(str(input.query), BRIEF_MAX);
    default:
      return '';
  }
}

/** Find a task id in a TaskCreate tool_response, whatever its exact shape. */
function createdTaskId(response: unknown): string {
  const r = obj(response);
  const task = obj(r.task);
  for (const candidate of [task.id, task.taskId, r.taskId, r.id]) {
    if (typeof candidate === 'string' && candidate) return candidate;
    if (typeof candidate === 'number') return String(candidate);
  }
  return '';
}

function taskLabelOf(input: Payload): string {
  return str(input.activeForm) || str(input.subject);
}

/** Hook state kept in the sidecar file: task labels by id and the id of the in_progress task. */
export interface TaskState {
  labels: TaskLabels;
  /** The task whose label is showing; only its completion clears the label. */
  active: string;
}

function remember(state: TaskState, id: string, label: string): TaskState {
  const labels = { ...state.labels, [id]: label };
  const keys = Object.keys(labels);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_TASKS))) delete labels[key];
  return { ...state, labels };
}

function idOf(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : '';
}

export interface HookResult {
  record: HookRecord | null;
  /** The updated sidecar state, when it changed. */
  state?: TaskState | undefined;
}

/**
 * Pure core: map one hook payload to the record to append (or none).
 * `kind` is the hook the script was installed as.
 */
export function handleHook(kind: string, payload: Payload, state: TaskState, ts: string): HookResult {
  const tool = str(payload.tool_name);
  const input = obj(payload.tool_input);

  if (kind === 'permission') {
    if (payload.notification_type !== 'permission_prompt') return { record: null };
    return { record: { type: 'permission', message: str(payload.message), ts } };
  }

  if (kind === 'tool') {
    if (!tool) return { record: null };
    const record: HookRecord = { type: 'tool', tool, brief: toolBrief(tool, input, str(payload.cwd)), ts };
    // Sub-agent spawns also carry their agent type: phase inference recognises reviewers by it.
    const subagent = tool === 'Agent' || tool === 'Task' ? clip(str(input.subagent_type), BRIEF_MAX) : '';
    if (subagent) record.subagent_type = subagent;
    // TaskCreate learns its id only from the response: remember the label for later status-only updates.
    if (tool === 'TaskCreate') {
      const id = createdTaskId(payload.tool_response);
      const label = taskLabelOf(input);
      if (id) {
        let next = label ? remember(state, id, label) : state;
        if (input.status === 'in_progress') next = { ...next, active: id };
        if (next !== state) return { record, state: next };
      }
    }
    return { record };
  }

  if (kind === 'todo') {
    if (tool === 'TodoWrite') {
      const todos = Array.isArray(input.todos) ? input.todos.map(obj) : [];
      const active = todos.find((t) => t.status === 'in_progress');
      const label = active ? str(active.activeForm) || str(active.content) : '';
      return { record: { type: 'activity', label: clip(label, LABEL_MAX), source: 'todo', ts } };
    }
    if (tool === 'TaskCreate' || tool === 'TaskUpdate') {
      const id = idOf(input.taskId);
      const own = taskLabelOf(input);
      let next: TaskState | undefined = id && own ? remember(state, id, own) : undefined;
      if (input.status === 'in_progress') {
        const label = own || (id ? state.labels[id] ?? '' : '');
        if (id) next = { ...(next ?? state), active: id };
        if (!label) return { record: null, state: next };
        return { record: { type: 'activity', label: clip(label, LABEL_MAX), source: 'todo', ts }, state: next };
      }
      if ((input.status === 'completed' || input.status === 'deleted') && id && id === state.active) {
        // An empty label clears the run's to-do label so the finished in_progress item stops showing.
        return { record: { type: 'activity', label: '', source: 'todo', ts }, state: { ...(next ?? state), active: '' } };
      }
      return { record: null, state: next };
    }
  }
  return { record: null };
}

export function taskLabelsPath(eventsFile: string): string {
  return `${eventsFile}.tasks.json`;
}

function readState(path: string): TaskState {
  try {
    const parsed = obj(JSON.parse(readFileSync(path, 'utf8')));
    const labels: TaskLabels = {};
    for (const [key, value] of Object.entries(obj(parsed.labels))) if (typeof value === 'string') labels[key] = value;
    return { labels, active: str(parsed.active) };
  } catch {
    return { labels: {}, active: '' };
  }
}

/** Run one hook invocation against raw stdin text. Never throws. */
export function runHook(kind: string, eventsFile: string, stdin: string, now: Date = new Date()): void {
  try {
    if (!eventsFile) return;
    const payload = obj(JSON.parse(stdin));
    const needsState = kind === 'todo' || payload.tool_name === 'TaskCreate';
    const sidecar = taskLabelsPath(eventsFile);
    const empty: TaskState = { labels: {}, active: '' };
    const { record, state } = handleHook(kind, payload, needsState ? readState(sidecar) : empty, now.toISOString());
    if (state) {
      // Parallel tool calls run hooks concurrently: write-then-rename so a reader never sees a truncated map.
      const tmp = `${sidecar}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, sidecar);
    }
    if (record) appendFileSync(eventsFile, `${JSON.stringify(record)}\n`);
  } catch {
    // Bad input or an unwritable file: drop the event, never fail the tool call.
  }
}

/** True when run as `node orc-hook.(ts|js)`, not imported (import.meta.main needs Node ≥ 24.2). */
function isEntry(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntry()) {
  const [kind = '', eventsFile = ''] = process.argv.slice(2);
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => { data += chunk; });
  process.stdin.on('end', () => { runHook(kind, eventsFile, data); process.exit(0); });
  process.stdin.on('error', () => process.exit(0));
}
