# Task 19 — Orchestrator: `orc:task:create` CLI

> **Part D — Master Agent, Step 1 of 4.** No dependencies. Can run in parallel with Task 20.

## Context

`orc:delegate` updates existing tasks but cannot add new ones. The master agent must be able
to create tasks in the backlog at runtime — it is the only entity that should do so during
autonomous operation. Without this command the master agent has no way to translate user intent
into work items.

`task_added` is already a valid event type in `schemas/event.schema.json`. `lib/args.mjs`
currently has `flag()` and `intFlag()` but no way to collect repeated flags (`--ac` appearing
multiple times). A `flagAll()` helper is needed.

---

## Goals

1. Add `flagAll(name, argv)` to `lib/args.mjs`.
2. Create `cli/task-create.mjs`.
3. Wire it into `package.json` as `orc:task:create`.

---

## Step-by-Step Instructions

### Step 1 — Add `flagAll` to `lib/args.mjs`

Append after the existing `intFlag` export:

```js
/**
 * Collect all --name=value occurrences from argv.
 * Returns an array of value strings (empty array if the flag never appears).
 */
export function flagAll(name, argv = process.argv.slice(2)) {
  return argv
    .filter((a) => a.startsWith(`--${name}=`))
    .map((a) => a.split('=').slice(1).join('='));
}
```

### Step 2 — Create `cli/task-create.mjs`

Create the file. Full implementation:

```js
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

const epicRef   = flag('epic');
const title     = flag('title');
const taskType  = flag('task-type') ?? 'implementation';
const actorId   = flag('actor-id') ?? 'human';

if (!epicRef || !title) {
  console.error('Usage: orc:task:create --epic=<ref> --title=<text> [options]');
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
const taskRef  = `${epicRef}/${taskSlug}`;

const newTask = {
  ref:    taskRef,
  title,
  status: 'todo',
  task_type:      taskType,
  planning_state: 'ready_for_dispatch',
  delegated_by:   actorId,
  depends_on:             flagAll('depends-on'),
  acceptance_criteria:    flagAll('ac'),
  required_capabilities:  flagAll('required-capabilities'),
  created_at:  now,
  updated_at:  now,
};

const description = flag('description');
if (description) newTask.description = description;

const owner = flag('owner');
if (owner) newTask.owner = owner;

// Remove empty arrays to keep JSON tidy.
for (const k of ['depends_on', 'acceptance_criteria', 'required_capabilities']) {
  if (newTask[k].length === 0) delete newTask[k];
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

    epic.tasks = [...(epic.tasks ?? []), newTask];
    atomicWriteJson(backlogPath, backlog);

    appendSequencedEvent(
      STATE_DIR,
      {
        ts:         now,
        event:      'task_added',
        actor_type: actorId === 'human' ? 'human' : 'agent',
        actor_id:   actorId,
        task_ref:   taskRef,
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
```

### Step 3 — Add npm script to `package.json`

In the `scripts` block, add after `orc:delegate`:

```json
"orc:task:create": "node cli/task-create.mjs",
```

### Step 4 — Write tests: `cli/task-create.test.mjs`

Create a test file following the pattern in `cli/delegate-task.test.mjs`.
Seed a minimal state directory with a `docs` epic. Cover:

1. Creates a task with the correct `ref`, `status: 'todo'`, `planning_state: 'ready_for_dispatch'`.
2. Populates `acceptance_criteria` from repeated `--ac` flags.
3. Generates a slug from title when `--ref` is omitted.
4. Fails when the epic does not exist.
5. Fails when the task `ref` already exists.
6. Emits a `task_added` event to `events.jsonl`.

### Step 5 — Run tests

```
nvm use 22 && npm run test:orch
```

---

## Acceptance Criteria

- [ ] `lib/args.mjs` exports `flagAll(name, argv?)`.
- [ ] `cli/task-create.mjs` exists and is executable via `node`.
- [ ] `npm run orc:task:create` is wired in `package.json`.
- [ ] Task is written to the correct epic in `backlog.json` with `status: 'todo'` and `planning_state: 'ready_for_dispatch'`.
- [ ] Repeated `--ac` flags populate `acceptance_criteria` array.
- [ ] A `task_added` event is appended to `events.jsonl`.
- [ ] Exits with code 1 and a clear message when epic is not found.
- [ ] Exits with code 1 when the task `ref` already exists.
- [ ] All orchestrator tests pass.
