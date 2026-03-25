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
import { BACKLOG_DOCS_DIR, STATE_DIR } from '../lib/paths.ts';
import { findTask, getNextTaskSeq, readBacklog } from '../lib/stateReader.ts';
import { TASK_TYPES, AGENT_ID_RE, TASK_REF_RE } from '../lib/constants.ts';
import { isSupportedProvider } from '../lib/providers.ts';
import { assertTaskRegistrationFieldsAllowed, assertTaskSpecMatchesRegistration } from '../lib/taskAuthority.ts';
import { syncBacklogFromSpecs } from '../lib/backlogSync.ts';
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

const requiredCapabilities = flagAll('required-capabilities');

try {
  assertTaskRegistrationFieldsAllowed({
    description: flag('description'),
    acceptance_criteria: flagAll('ac').length > 0 ? flagAll('ac') : undefined,
    depends_on: flagAll('depends-on').length > 0 ? flagAll('depends-on') : undefined,
  });
  withLock(join(STATE_DIR, '.lock'), () => {
    const backlogPath = join(STATE_DIR, 'backlog.json');
    const beforeSync = readBacklog(STATE_DIR);
    const existing = findTask(beforeSync, taskRef);
    if (existing) {
      throw new Error(`Task already exists: ${taskRef}`);
    }

    assertTaskSpecMatchesRegistration({ taskRef, featureRef, title });
    syncBacklogFromSpecs(STATE_DIR, BACKLOG_DOCS_DIR, { lockAlreadyHeld: true });

    const backlog = readBacklog(STATE_DIR);
    const currentNextTaskSeq = getNextTaskSeq(backlog);
    const task = findTask(backlog, taskRef);
    if (!task) {
      throw new Error(`Task spec did not sync into orchestrator state: ${taskRef}`);
    }

    task.task_type = taskType as Task['task_type'];
    task.planning_state = 'ready_for_dispatch';
    task.delegated_by = actorId;
    task.updated_at = now;
    task.created_at ??= now;
    if (requiredCapabilities.length > 0) task.required_capabilities = requiredCapabilities;
    if (owner) task.owner = owner;
    if (requiredProvider) task.required_provider = requiredProvider as Task['required_provider'];
    backlog.next_task_seq = currentNextTaskSeq + 1;
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
