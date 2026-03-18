#!/usr/bin/env node
/**
 * cli/task-create.ts
 * Usage:
 *   node cli/task-create.ts \
 *     --feature=<ref> --title=<text> \
 *     [--ref=<slug>] \
 *     [--task-type=<implementation|refactor>] \
 *     [--description=<text>] \
 *     [--ac=<criterion>] \           (repeatable)
 *     [--depends-on=<task-ref>] \    (repeatable)
 *     [--owner=<agent_id>] \
 *     [--required-capabilities=<cap>] \  (repeatable)
 *     [--required-provider=<codex|claude|gemini>] \
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
import { isSupportedProvider } from '../lib/providers.ts';
import type { Task } from '../types/backlog.ts';

const featureRef = flag('feature');
const title = flag('title');
const taskType = flag('task-type') ?? 'implementation';
const actorId = flag('actor-id') ?? 'human';

if (!featureRef || !title) {
  console.error('Usage: orc-task-create --feature=<ref> --title=<text> [options]');
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
const taskRef = `${featureRef}/${taskSlug}`;

if (!taskSlug) {
  console.error('Task slug is empty — title must contain at least one alphanumeric character (or provide --ref=<slug>).');
  process.exit(1);
}

if (!TASK_REF_RE.test(taskRef)) {
  console.error(`Invalid task ref: ${taskRef}. Both feature and slug must match [a-z0-9-]+.`);
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

const requiredProvider = flag('required-provider');
if (requiredProvider && !isSupportedProvider(requiredProvider)) {
  console.error(`Invalid required-provider: ${requiredProvider}. Must be codex, claude, or gemini.`);
  process.exit(1);
}

const newTask: Task = {
  ref: taskRef,
  title,
  status: 'todo',
  task_type: taskType as Task['task_type'],
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
if (requiredProvider) newTask.required_provider = requiredProvider as Task['required_provider'];

for (const key of ['depends_on', 'acceptance_criteria', 'required_capabilities'] as const) {
  const arr = newTask[key];
  if (Array.isArray(arr) && arr.length === 0) delete newTask[key];
}

try {
  withLock(join(STATE_DIR, '.lock'), () => {
    const backlogPath = join(STATE_DIR, 'backlog.json');
    const backlog = readBacklog(STATE_DIR);

    const feature = backlog.features.find((e) => e.ref === featureRef);
    if (!feature) {
      throw new Error(`Feature not found: ${featureRef}`);
    }

    const existing = feature.tasks.find((t) => t.ref === taskRef);
    if (existing) {
      throw new Error(`Task already exists: ${taskRef}`);
    }

    // Validate all depends_on refs exist in the backlog.
    if ((newTask.depends_on ?? []).length > 0) {
      const allRefs = new Set(backlog.features.flatMap((e) => e.tasks.map((t) => t.ref)));
      for (const dep of newTask.depends_on ?? []) {
        if (!allRefs.has(dep)) {
          throw new Error(`--depends-on task_ref not found in backlog: ${dep}`);
        }
      }
    }

    feature.tasks = [...feature.tasks, newTask];
    atomicWriteJson(backlogPath, backlog);

    appendSequencedEvent(
      STATE_DIR,
      {
        ts: now,
        event: 'task_added',
        actor_type: actorId === 'human' ? 'human' : 'agent',
        actor_id: actorId,
        task_ref: taskRef,
        payload: { title, task_type: taskType, feature_ref: featureRef },
      },
      { lockAlreadyHeld: true },
    );

    console.log(`task created: ${taskRef}`);
  });
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
