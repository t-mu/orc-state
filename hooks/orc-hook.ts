/**
 * Claude Code command hook for orc workers.
 *
 * Usage: node orc-hook.(ts|js) <permission|tool|todo> <events-file>
 *
 * Claude Code passes the hook payload as JSON on stdin. The script appends at
 * most one NDJSON record to <events-file> (drained by the coordinator, see
 * lib/hookEventBus.ts) and always exits 0, even on bad input: command hooks
 * are synchronous, so a failure or a slow path here stalls the worker's tool
 * call. It imports nothing but node:fs and node:path to keep startup small.
 *
 * Records never carry full tool inputs or outputs: `tool` records hold a
 * short `brief` (≤ 80 chars), `activity` records the current to-do label.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

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

function remember(labels: TaskLabels, id: string, label: string): TaskLabels {
  const next = { ...labels, [id]: label };
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_TASKS))) delete next[key];
  return next;
}

export interface HookResult {
  record: HookRecord | null;
  /** The updated task-label map, when it changed. */
  labels?: TaskLabels | undefined;
}

/**
 * Pure core: map one hook payload to the record to append (or none).
 * `kind` is the hook the script was installed as.
 */
export function handleHook(kind: string, payload: Payload, labels: TaskLabels, ts: string): HookResult {
  const tool = str(payload.tool_name);
  const input = obj(payload.tool_input);

  if (kind === 'permission') {
    if (payload.notification_type !== 'permission_prompt') return { record: null };
    return { record: { type: 'permission', message: str(payload.message), ts } };
  }

  if (kind === 'tool') {
    if (!tool) return { record: null };
    const record = { type: 'tool', tool, brief: toolBrief(tool, input, str(payload.cwd)), ts };
    // TaskCreate learns its id only from the response: remember the label for later status-only updates.
    if (tool === 'TaskCreate') {
      const id = createdTaskId(payload.tool_response);
      const label = taskLabelOf(input);
      if (id && label) return { record, labels: remember(labels, id, label) };
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
      const id = str(input.taskId) || (typeof input.taskId === 'number' ? String(input.taskId) : '');
      const own = taskLabelOf(input);
      let nextLabels: TaskLabels | undefined;
      if (id && own) nextLabels = remember(labels, id, own);
      if (input.status === 'in_progress') {
        const label = own || (id ? labels[id] ?? '' : '');
        if (!label) return { record: null, labels: nextLabels };
        return { record: { type: 'activity', label: clip(label, LABEL_MAX), source: 'todo', ts }, labels: nextLabels };
      }
      if (input.status === 'completed' || input.status === 'deleted') {
        // An empty label clears the run's to-do label so a finished item stops showing.
        return { record: { type: 'activity', label: '', source: 'todo', ts }, labels: nextLabels };
      }
      return { record: null, labels: nextLabels };
    }
  }
  return { record: null };
}

export function taskLabelsPath(eventsFile: string): string {
  return `${eventsFile}.tasks.json`;
}

function readLabels(path: string): TaskLabels {
  try {
    const parsed = obj(JSON.parse(readFileSync(path, 'utf8')));
    const out: TaskLabels = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') out[key] = value;
    return out;
  } catch {
    return {};
  }
}

/** Run one hook invocation against raw stdin text. Never throws. */
export function runHook(kind: string, eventsFile: string, stdin: string, now: Date = new Date()): void {
  try {
    if (!eventsFile) return;
    const payload = obj(JSON.parse(stdin));
    const needsLabels = kind === 'todo' || payload.tool_name === 'TaskCreate';
    const sidecar = taskLabelsPath(eventsFile);
    const { record, labels } = handleHook(kind, payload, needsLabels ? readLabels(sidecar) : {}, now.toISOString());
    if (labels) writeFileSync(sidecar, JSON.stringify(labels));
    if (record) appendFileSync(eventsFile, `${JSON.stringify(record)}\n`);
  } catch {
    // Bad input or an unwritable file: drop the event, never fail the tool call.
  }
}

if (import.meta.main) {
  const [kind = '', eventsFile = ''] = process.argv.slice(2);
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => { data += chunk; });
  process.stdin.on('end', () => { runHook(kind, eventsFile, data); process.exit(0); });
  process.stdin.on('error', () => process.exit(0));
}
