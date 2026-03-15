#!/usr/bin/env node
/**
 * cli/task-create.ts
 * Usage:
 *   node cli/task-create.ts \
 *     --epic=<ref> --title=<text> \
 *     [--ref=<slug>] \
 *     [--task-type=<implementation|refactor>] \
 *     [--description=<text>] \
 *     [--ac=<criterion>] \           (repeatable)
 *     [--depends-on=<task-ref>] \    (repeatable)
 *     [--owner=<agent_id>] \
 *     [--required-capabilities=<cap>] \  (repeatable)
 *     [--actor-id=<agent_id>]
 */
import { join } from 'node:path';
import { flag, flagAll } from '../lib/args.ts';
import { withLock } from '../lib/lock.ts';
import { atomicWriteJson } from '../lib/atomicWrite.ts';
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { readBacklog } from '../lib/stateReader.ts';
import { TASK_TYPES, AGENT_ID_RE, TASK_REF_RE } from '../lib/constants.ts';

const epicRef = flag('epic');
const title = flag('title');
const taskType = flag('task-type') ?? 'implementation';
const actorId = flag('actor-id') ?? 'human';

if (!epicRef || !title) {
  console.error('Usage: orc-task-create --epic=<ref> --title=<text> [options]');
  process.exit(1);
}

const VALID_TASK_TYPES = new Set(TASK_TYPES);
if (!VALID_TASK_TYPES.has(taskType)) {
  console.error(`Invalid task-type: ${taskType}. Must be implementation or refactor.`);
  process.exit(1);
}

function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

const now = new Date().toISOString();
const taskSlug = flag('ref') ?? slugify(title);
const taskRef = `${epicRef}/${taskSlug}`;

if (!taskSlug) {
  console.error('Task slug is empty — title must contain at least one alphanumeric character (or provide --ref=<slug>).');
  process.exit(1);
}

if (!TASK_REF_RE.test(taskRef)) {
  console.error(`Invalid task ref: ${taskRef}. Both epic and slug must match [a-z0-9-]+.`);
  process.exit(1);
}

if (!AGENT_ID_RE.test(actorId)) {
  console.error(`Invalid actor-id: ${actorId}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  process.exit(1);
}

const owner = flag('owner');
if (owner && !AGENT_ID_RE.test(owner)) {
  console.error(`Invalid owner: ${owner}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  process.exit(1);
}

const newTask: Record<string, unknown> = {
  ref: taskRef,
  title,
  status: 'todo',
  task_type: taskType,
  planning_state: 'ready_for_dispatch',
  delegated_by: actorId,
  depends_on: flagAll('depends-on'),
  acceptance_criteria: flagAll('ac'),
  required_capabilities: flagAll('required-capabilities'),
  created_at: now,
  updated_at: now,
};

const description = flag('description');
if (description) newTask.description = description;

if (owner) newTask.owner = owner;

for (const key of ['depends_on', 'acceptance_criteria', 'required_capabilities']) {
  if ((newTask[key] as unknown[]).length === 0) delete newTask[key];
}

try {
  withLock(join(STATE_DIR, '.lock'), () => {
    const backlogPath = join(STATE_DIR, 'backlog.json');
    const backlog = readBacklog(STATE_DIR) as unknown as Record<string, unknown>;

    const epic = ((backlog.epics ?? []) as Array<Record<string, unknown>>).find((e) => e.ref === epicRef);
    if (!epic) {
      throw new Error(`Epic not found: ${epicRef}`);
    }

    const existing = ((epic.tasks ?? []) as Array<Record<string, unknown>>).find((t) => t.ref === taskRef);
    if (existing) {
      throw new Error(`Task already exists: ${taskRef}`);
    }

    // Validate all depends_on refs exist in the backlog.
    if (((newTask.depends_on as unknown[]) ?? []).length > 0) {
      const allRefs = new Set(
        ((backlog.epics ?? []) as Array<Record<string, unknown>>).flatMap((e) => ((e.tasks ?? []) as Array<Record<string, unknown>>).map((t) => t.ref)),
      );
      for (const dep of newTask.depends_on as string[]) {
        if (!allRefs.has(dep)) {
          throw new Error(`--depends-on task_ref not found in backlog: ${dep}`);
        }
      }
    }

    epic.tasks = [...((epic.tasks ?? []) as unknown[]), newTask];
    atomicWriteJson(backlogPath, backlog);

    appendSequencedEvent(
      STATE_DIR,
      {
        ts: now,
        event: 'task_added',
        actor_type: actorId === 'human' ? 'human' : 'agent',
        actor_id: actorId,
        task_ref: taskRef,
        payload: { title, task_type: taskType, epic_ref: epicRef },
      },
      { lockAlreadyHeld: true },
    );

    console.log(`task created: ${taskRef}`);
  });
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
