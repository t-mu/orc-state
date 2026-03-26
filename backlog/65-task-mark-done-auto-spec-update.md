---
ref: runtime-robustness/65-task-mark-done-auto-spec-update
title: "Unify task completion and enforce phased workflow gates"
status: todo
feature: runtime-robustness
task_type: implementation
priority: high
depends_on: []
---

# Task 65 — Unify Task Completion and Enforce Phased Workflow Gates

Independent.

## Scope

**In scope:**
- **Piece 1:** `orc task-mark-done <ref>` updates the markdown spec frontmatter `status: done` automatically, then syncs state. One command replaces three manual steps.
- **Piece 2:** `orc run-work-complete` rejects if the task is not `status: done` in backlog.json. This is the mechanical gate that prevents agents from signaling completion without bookkeeping.
- **Piece 3:** Rewrite the AGENTS.md workflow section with explicit phases and gates.

**Out of scope:**
- Changes to `task-reset` or `task-unblock` (separate tasks if needed).
- Changes to the backlog sync mechanism itself.
- Phase-tracking events (`orc progress --phase=explore`) — useful for observability but not gates.
- Adding a generic "update any frontmatter field" utility.

---

## Context

### Current state

Completing a task requires three separate manual steps:
1. Edit `backlog/<N>-<slug>.md` — change `status: todo` → `status: done`
2. Run `orc task-mark-done <ref>` — updates `backlog.json`
3. Run `orc backlog-sync-check` — verifies they match

Agents routinely forget step 1 (updating the markdown spec), leaving the spec and state out of sync. There is no mechanical enforcement — `orc run-work-complete` accepts the signal regardless of task status.

The AGENTS.md workflow is a flat numbered list under "Finish" with no phasing or gate definitions. Agents skip steps because nothing enforces them.

### Desired state

`orc task-mark-done <ref>` is a single atomic action: writes `status: done` to the markdown frontmatter, syncs backlog.json, and verifies the sync. Agents call one command.

`orc run-work-complete` verifies the task is `status: done` in backlog.json before accepting. If not, it rejects with a clear error telling the agent to call `orc task-mark-done` first. This is provider-agnostic — it's a CLI exit code that works for Claude, Codex, and Gemini.

AGENTS.md defines five phases with gates:

| Phase | What | Gate |
|-------|------|------|
| 1. Explore | Read spec, identify files | `orc run-start` |
| 2. Implement | Code + tests | `npm test` passes |
| 3. Review | Commit → spawn reviewers → address findings → fixup commit | All reviewers accept |
| 4. Complete | `orc task-mark-done` → rebase → `orc run-work-complete` | `run-work-complete` rejects if task not done |
| 5. Finalize | Wait for coordinator follow-up | `orc run-finish` |

### Start here

- `cli/task-mark-done.ts` — current implementation (asserts spec is already done)
- `cli/run-work-complete.ts` — currently has no task status check
- `lib/backlogSync.ts` — `discoverActiveTaskSpecs()` for spec file discovery
- `AGENTS.md` — workflow section to rewrite

**Affected files:**
- `cli/task-mark-done.ts` — write spec status before sync
- `cli/run-work-complete.ts` — add task status gate
- `AGENTS.md` — rewrite workflow with phases and gates

---

## Goals

1. Must make `task-mark-done` update the markdown spec frontmatter to `status: done` before syncing state.
2. Must locate the correct spec file by matching the task ref via `discoverActiveTaskSpecs()`.
3. Must fail `task-mark-done` with a clear error if the spec file is not found.
4. Must work when spec is already `status: done` (idempotent).
5. Must make `run-work-complete` reject with exit code 1 if task status is not `done` in backlog.json.
6. Must include a clear error message: "task not marked done — call orc task-mark-done <ref> first".
7. Must rewrite AGENTS.md with the five-phase workflow and gate definitions.

---

## Implementation

### Step 1 — Make task-mark-done write spec status

**File:** `cli/task-mark-done.ts`

Before the existing `assertTaskSpecStatus` call, add:
1. Import `discoverActiveTaskSpecs` from `../lib/backlogSync.ts` and `readFileSync`, `writeFileSync` from `node:fs`
2. Find the spec entry matching `taskRef`
3. Read the spec file, replace `status: <current>` with `status: done` in frontmatter
4. Write back to the file
5. Remove the `assertTaskSpecStatus(taskRef, 'done')` call (now redundant)

```typescript
const specs = discoverActiveTaskSpecs(BACKLOG_DOCS_DIR);
const spec = specs.find((s) => s.ref === taskRef);
if (!spec) {
  throw new Error(`Task spec not found in backlog/: ${taskRef}`);
}
const specPath = join(BACKLOG_DOCS_DIR, spec.file);
const content = readFileSync(specPath, 'utf8');
const updated = content.replace(/^(status:\s*).+$/m, '$1done');
if (updated === content && spec.status !== 'done') {
  throw new Error(`Could not locate status field in frontmatter of ${spec.file}`);
}
if (spec.status !== 'done') {
  writeFileSync(specPath, updated, 'utf8');
}
```

### Step 2 — Add task status gate to run-work-complete

**File:** `cli/run-work-complete.ts`

After loading the claim (which has `task_ref`), check the task status:

```typescript
import { readBacklog, findTask } from '../lib/stateReader.ts';

const backlog = readBacklog(STATE_DIR);
const task = findTask(backlog, validatedClaim.task_ref);
if (task && task.status !== 'done') {
  console.error(
    `Error: task not marked done — call orc task-mark-done ${validatedClaim.task_ref} first`
  );
  process.exit(1);
}
```

This check runs after claim validation so the error message can include the task_ref. If the task is not found in backlog (edge case), skip the check — don't block on missing data.

### Step 3 — Rewrite AGENTS.md workflow

**File:** `AGENTS.md`

Replace the "Worktree Workflow" and "Finish" sections with the phased workflow below.
Use imperative, direct language optimized for LLM agents — these instructions are
consumed by Claude, Codex, and Gemini workers. Avoid hedging or suggestions; state
requirements as commands.

```markdown
## Phased Workflow

Every task MUST follow these five phases in order. Each phase has a gate —
a command that MUST exit 0 before you proceed to the next phase.
Do NOT skip phases. Do NOT reorder phases.

### Phase 1 — Explore

Read the full task spec in `backlog/<N>-<slug>.md`. Identify all affected files.
Check existing patterns in those files before writing any code.

**Gate:** Run `orc run-start --run-id=<run_id> --agent-id=<agent_id>`.
Start the background heartbeat immediately after:
```bash
while true; do sleep 270; orc run-heartbeat --run-id=<run_id> --agent-id=<agent_id>; done &
HEARTBEAT_PID=$!
```
Do NOT write code until run-start succeeds.

### Phase 2 — Implement

Write code changes. Write tests for all new logic. Run `npm test`.

**Gate:** `npm test` MUST exit 0. Do NOT proceed to Phase 3 with failing tests.

### Phase 3 — Review

1. Commit your changes: `git commit -m "feat(<scope>): <outcome>"`
2. Spawn two sub-agent reviewers. Give each the acceptance criteria and `git diff main`.
   Each reviewer MUST call `orc review-submit` before returning.
3. Retrieve findings: `orc review-read --run-id=<run_id>`
4. Address ALL findings in a fixup commit.

**Gate:** All reviewers report `approved` via `orc review-read`. One review round only.

### Phase 4 — Complete

1. Mark the task done (updates spec + state in one action):
   `orc task-mark-done <task-ref>`
2. Rebase onto main: `git rebase main`
3. Signal the coordinator:
   `orc run-work-complete --run-id=<run_id> --agent-id=<agent_id>`

**Gate:** `run-work-complete` MUST exit 0. It rejects if task-mark-done was not called.
Do NOT call run-work-complete without calling task-mark-done first.

### Phase 5 — Finalize

Wait for coordinator follow-up. If coordinator requests a finalize rebase, execute it.
When coordinator confirms success, stop heartbeat and signal finish:
```bash
kill $HEARTBEAT_PID 2>/dev/null || true
orc run-finish --run-id=<run_id> --agent-id=<agent_id>
```

**Gate:** `orc run-finish` — terminal success signal. Do NOT merge to main yourself.
```

Invariant: keep the existing "Blessed Paths", "Commands", "Heartbeat requirement", and other reference sections unchanged.

---

## Acceptance criteria

- [ ] `orc task-mark-done <ref>` updates the markdown spec `status: done` automatically.
- [ ] `orc task-mark-done <ref>` updates backlog.json via sync.
- [ ] `orc task-mark-done <ref>` emits `task_updated` event.
- [ ] `task-mark-done` fails with clear error if spec file not found.
- [ ] `task-mark-done` works when spec is already `status: done` (idempotent).
- [ ] `run-work-complete` exits 1 when task is not `status: done`.
- [ ] `run-work-complete` exits 0 when task is `status: done`.
- [ ] Error message includes the task ref and tells agent to call `task-mark-done`.
- [ ] `backlog-sync-check` passes after `task-mark-done`.
- [ ] AGENTS.md contains five-phase workflow with gate definitions.
- [ ] No changes to files outside stated scope.

---

## Tests

Add to `cli/task-mark-done.test.ts` (create if it doesn't exist):

```typescript
it('updates markdown spec status to done', () => { ... });
it('updates backlog.json via sync', () => { ... });
it('is idempotent when spec is already done', () => { ... });
it('fails when spec file not found', () => { ... });
it('fails when frontmatter has no status line', () => { ... });
```

Add to `cli/run-work-complete.test.ts` (or `cli/run-reporting.test.ts`):

```typescript
it('rejects run-work-complete when task status is not done', () => { ... });
it('accepts run-work-complete when task status is done', () => { ... });
```

---

## Verification

```bash
npx vitest run cli/task-mark-done.test.ts
npx vitest run cli/run-reporting.test.ts
```

```bash
nvm use 24 && npm test
```

```bash
orc backlog-sync-check
# Expected: exits 0
```
