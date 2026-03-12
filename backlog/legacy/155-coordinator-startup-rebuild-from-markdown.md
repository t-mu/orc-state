---
ref: orch/task-155-coordinator-startup-rebuild-from-markdown
epic: orch
status: done
---

# Task 155 — Coordinator Startup Rebuild from Markdown

Depends on Task 153. Blocks nothing directly.

## Scope

**In scope:**
- Add a `syncBacklogFromSpecs(stateDir, docsDir)` function (new file `lib/backlogSync.mjs`) that reads all numbered spec files in `docs/backlog/`, extracts `ref`, `epic`, `status` from YAML frontmatter, and upserts tasks into `.orc-state/backlog.json`.
- Call `syncBacklogFromSpecs` during coordinator startup (in `coordinator.mjs`) before the main tick loop begins.
- Ensure the `orch` epic (and any other epic found in specs) is auto-created if absent.
- Preserve active tasks: if a task already exists in state with status `todo`, `claimed`, or `in_progress`, leave it unchanged. Only add missing tasks or update tasks that are `blocked`/`done`/absent.

**Out of scope:**
- Spec files without a `ref:` or `status:` field — skip silently.
- The `backlog:sync:check` script — modified in Task 156, not here.
- Changes to `mcp/handlers.mjs` or any MCP tool handler.
- Changes to `AGENTS.md` or any template file.

---

## Context

### Current state

`.orc-state/backlog.json` is runtime state that is gitignored. When it is wiped (coordinator restart after a migration, accidental deletion, or environment reset), all task status information is lost. Recovery requires manual `create_task` MCP calls for every spec — as demonstrated in the session that prompted this task series.

### Desired state

On every coordinator startup, `syncBacklogFromSpecs` runs before the tick loop. It reads the `status:` fields from the markdown specs (which are git-tracked and always accurate after Task 153 + 154 land) and upserts missing tasks into state. A wiped `.orc-state/` directory is recovered automatically on next coordinator start — no manual intervention required.

### Start here

- `coordinator.mjs` — find the startup sequence (before first tick)
- `lib/stateReader.mjs` — understand how backlog.json is read today
- `lib/atomicWrite.mjs` + `lib/lock.mjs` — required write utilities
- `scripts/backlog_sync_check.mjs` — reference for how spec files are parsed (same regex)

**Affected files:**
- `lib/backlogSync.mjs` — new file, contains `syncBacklogFromSpecs`
- `lib/backlogSync.test.mjs` — new test file
- `coordinator.mjs` — add startup call to `syncBacklogFromSpecs`

---

## Goals

1. Must implement `syncBacklogFromSpecs(stateDir, docsDir)` in a new `lib/backlogSync.mjs` module.
2. Must parse `ref:`, `epic:`, and `status:` from YAML frontmatter using the same regex pattern as `backlog_sync_check.mjs`.
3. Must auto-create any epic found in specs that does not yet exist in `backlog.json`.
4. Must upsert each parsed task: add it if absent, skip it if already in an active state (`todo`/`claimed`/`in_progress`).
5. Must use `withLock` + `atomicWriteJson` for all writes — no direct `writeFileSync` calls.
6. Must call `syncBacklogFromSpecs` from the coordinator startup path before the first tick.
7. Must be safe to call on every coordinator start even when state is already correct (idempotent).

---

## Implementation

### Step 1 — Create `lib/backlogSync.mjs`

**File:** `lib/backlogSync.mjs` (new)

```js
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from './lock.mjs';
import { atomicWriteJson } from './atomicWrite.mjs';

const ACTIVE_STATUSES = new Set(['todo', 'claimed', 'in_progress']);

function parseSpecFrontmatter(text) {
  const ref = text.match(/^ref:\s+(.+)$/m)?.[1]?.trim();
  const epic = text.match(/^epic:\s+(.+)$/m)?.[1]?.trim();
  const status = text.match(/^status:\s+(.+)$/m)?.[1]?.trim();
  return { ref, epic, status };
}

export function syncBacklogFromSpecs(stateDir, docsDir) {
  const specFiles = readdirSync(docsDir)
    .filter((name) => /^\d+-.+\.md$/.test(name));

  const specs = specFiles.flatMap((name) => {
    const text = readFileSync(join(docsDir, name), 'utf8');
    const { ref, epic, status } = parseSpecFrontmatter(text);
    if (!ref || !epic || !status) return [];
    return [{ ref, epic, status }];
  });

  if (specs.length === 0) return;

  const backlogPath = join(stateDir, 'backlog.json');

  withLock(join(stateDir, '.lock'), () => {
    const backlog = JSON.parse(readFileSync(backlogPath, 'utf8'));

    for (const spec of specs) {
      // Ensure epic exists
      if (!backlog.epics.some((e) => e.ref === spec.epic)) {
        const title = spec.epic.charAt(0).toUpperCase() + spec.epic.slice(1);
        backlog.epics.push({ ref: spec.epic, title, tasks: [] });
      }

      const epicObj = backlog.epics.find((e) => e.ref === spec.epic);
      const existing = epicObj.tasks.find((t) => t.ref === spec.ref);

      if (!existing) {
        // Add missing task with status from spec
        const now = new Date().toISOString();
        epicObj.tasks.push({
          ref: spec.ref,
          title: spec.ref, // minimal title; worker will have the full spec
          status: spec.status,
          task_type: 'implementation',
          created_at: now,
          updated_at: now,
        });
      } else if (!ACTIVE_STATUSES.has(existing.status)) {
        // Update terminal/blocked task status to match spec
        existing.status = spec.status;
        existing.updated_at = new Date().toISOString();
      }
      // else: existing active task — leave untouched
    }

    atomicWriteJson(backlogPath, backlog);
  });
}
```

### Step 2 — Call from coordinator startup

**File:** `coordinator.mjs`

Find the coordinator startup sequence (the section that runs before the main tick/interval). Import and call `syncBacklogFromSpecs`:

```js
import { syncBacklogFromSpecs } from './lib/backlogSync.mjs';
import { join } from 'node:path';

// Near the top of the startup path, before the first tick:
const docsDir = join(process.cwd(), 'docs', 'backlog');
syncBacklogFromSpecs(stateDir, docsDir);
```

Wrap in a try/catch so a missing `docs/backlog/` directory (e.g. in test environments) does not crash the coordinator:

```js
try {
  syncBacklogFromSpecs(stateDir, docsDir);
} catch (err) {
  // Non-fatal: log and continue
  console.warn('[coordinator] backlog sync from specs skipped:', err.message);
}
```

### Step 3 — Write tests

**File:** `lib/backlogSync.test.mjs` (new)

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { syncBacklogFromSpecs } from './backlogSync.mjs';

describe('syncBacklogFromSpecs', () => {
  it('adds a missing task from a spec file with status: todo', () => { ... });
  it('adds a missing epic when spec references an unknown epic', () => { ... });
  it('does not modify a task already in todo/claimed/in_progress status', () => { ... });
  it('updates a blocked task to match the spec status', () => { ... });
  it('is idempotent when called twice with the same specs', () => { ... });
  it('skips spec files without ref: or status: fields', () => { ... });
});
```

---

## Acceptance criteria

- [ ] `lib/backlogSync.mjs` exists and exports `syncBacklogFromSpecs`.
- [ ] Wiping `backlog.json` epics to `[]` and restarting the coordinator restores all tasks from spec files.
- [ ] Tasks in `todo`/`claimed`/`in_progress` state are not overwritten.
- [ ] A missing epic referenced in a spec file is created automatically.
- [ ] `syncBacklogFromSpecs` is idempotent — calling it twice produces the same state.
- [ ] Spec files missing `ref:`, `epic:`, or `status:` are silently skipped (no crash).
- [ ] `npm run backlog:sync:check` passes after a coordinator restart following a state wipe.
- [ ] No changes to files outside `lib/backlogSync.mjs`, `lib/backlogSync.test.mjs`, and `coordinator.mjs`.

---

## Tests

**File:** `lib/backlogSync.test.mjs` (new)

```js
it('adds a missing task from a spec file with status: todo', () => { ... });
it('adds a missing epic when spec references an unknown epic', () => { ... });
it('does not modify a task already in todo/claimed/in_progress status', () => { ... });
it('updates a blocked task to match the spec status', () => { ... });
it('is idempotent when called twice with the same specs', () => { ... });
it('skips spec files without ref: or status: fields', () => { ... });
```

---

## Verification

```bash
nvm use 24 && npx vitest run lib/backlogSync.test.mjs
```

```bash
# Integration smoke test: wipe state and restart coordinator
node -e "
  const {readFileSync, writeFileSync} = require('fs');
  const b = JSON.parse(readFileSync('.orc-state/backlog.json'));
  b.epics = [];
  writeFileSync('.orc-state/backlog.json', JSON.stringify(b, null, 2));
  console.log('wiped');
"
# then restart coordinator and check:
nvm use 24 && npm run backlog:sync:check
```

```bash
nvm use 24 && npm run build
nvm use 24 && npm test
```

```bash
npm run orc:doctor
# Expected: exits 0
```

## Risk / Rollback

**Risk:** If the spec parsing regex matches a malformed frontmatter line or a file is mid-write during startup, `syncBacklogFromSpecs` could insert a task with an empty or invalid ref. The `withLock` + `atomicWriteJson` pattern prevents partial writes but not bad parses.

**Rollback:** `git restore .orc-state/backlog.json` (if tracked) or restore from last known good backup; re-run `orc:doctor` to validate.
