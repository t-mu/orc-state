#!/usr/bin/env node
/**
 * cli/task-create.mjs
 * Usage:
 *   node cli/task-create.mjs \
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flag, flagAll } from '../lib/args.mjs';
import { withLock } from '../lib/lock.mjs';
import { atomicWriteJson } from '../lib/atomicWrite.mjs';
import { appendSequencedEvent } from '../lib/eventLog.mjs';
import { STATE_DIR } from '../lib/paths.mjs';

const epicRef = flag('epic');
const title = flag('title');
const taskType = flag('task-type') ?? 'implementation';
const actorId = flag('actor-id') ?? 'human';

if (!epicRef || !title) {
  console.error('Usage: orc-task-create --epic=<ref> --title=<text> [options]');
  process.exit(1);
}

const VALID_TASK_TYPES = new Set(['implementation', 'refactor']);
if (!VALID_TASK_TYPES.has(taskType)) {
  console.error(`Invalid task-type: ${taskType}. Must be implementation or refactor.`);
  process.exit(1);
}

function slugify(text) {
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

if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(taskRef)) {
  console.error(`Invalid task ref: ${taskRef}. Both epic and slug must match [a-z0-9-]+.`);
  process.exit(1);
}

const ACTOR_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
if (!ACTOR_ID_RE.test(actorId)) {
  console.error(`Invalid actor-id: ${actorId}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  process.exit(1);
}

const owner = flag('owner');
if (owner && !/^[a-z0-9][a-z0-9-]*$/.test(owner)) {
  console.error(`Invalid owner: ${owner}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  process.exit(1);
}

const newTask = {
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
  if (newTask[key].length === 0) delete newTask[key];
}

try {
  withLock(join(STATE_DIR, '.lock'), () => {
    const backlogPath = join(STATE_DIR, 'backlog.json');
    const backlog = JSON.parse(readFileSync(backlogPath, 'utf8'));

    const epic = (backlog.epics ?? []).find((e) => e.ref === epicRef);
    if (!epic) {
      throw new Error(`Epic not found: ${epicRef}`);
    }

    const existing = (epic.tasks ?? []).find((t) => t.ref === taskRef);
    if (existing) {
      throw new Error(`Task already exists: ${taskRef}`);
    }

    // Validate all depends_on refs exist in the backlog.
    if ((newTask.depends_on ?? []).length > 0) {
      const allRefs = new Set(
        (backlog.epics ?? []).flatMap((e) => (e.tasks ?? []).map((t) => t.ref)),
      );
      for (const dep of newTask.depends_on) {
        if (!allRefs.has(dep)) {
          throw new Error(`--depends-on task_ref not found in backlog: ${dep}`);
        }
      }
    }

    epic.tasks = [...(epic.tasks ?? []), newTask];
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
  console.error(err.message);
  process.exit(1);
}
