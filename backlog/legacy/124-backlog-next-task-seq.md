---
ref: orch/task-124-backlog-next-task-seq
epic: orch
status: done
---

# Task 124 — Track next_task_seq in backlog.json and Expose via MCP

Independent. Blocks nothing; improves create-task skill ergonomics once done.

## Scope

**In scope:**
- `lib/stateReader.mjs` — add `getNextTaskSeq(backlog)` helper that reads or bootstraps `next_task_seq`
- `mcp/handlers.mjs` — `handleCreateTask`: read seq, return it in response, increment and save; `handleGetStatus` (Task 123 preview): include `next_task_seq` field
- `mcp/handlers.test.mjs` — tests for seq increment and bootstrap from existing refs
- `.codex/skills/create-task/SKILL.md` and `.claude/skills/create-task/SKILL.md` — update Step 0 to read `next_task_seq` from `get_status`; retain the shell fallback as a comment

**Out of scope:**
- Changing the backlog JSON schema validation (AJV) — `next_task_seq` is a top-level additive field
- Enforcing that task slugs use the seq number (convention only, not validated)
- Auto-numbering task refs from the seq (the slug is still supplied by the caller)
- Changing handlers unrelated to task creation/status sequence reporting

---

## Context

The `create-task` skill currently finds the next task number with:

```bash
ls docs/backlog/ | grep -oE '^[0-9]+' | sort -n | tail -1 | xargs -I{} expr {} + 1
```

This is a filesystem shell pipeline that works but is fragile: it depends on the working directory, filename conventions, and shell availability. It has no awareness of the MCP backlog state and cannot be called from a tool invocation — only from a bash step.

The right source of truth is `backlog.json` itself. Adding a `next_task_seq` counter there means any MCP client (the skill, the master agent, a future UI) can get the next number with a single tool call and no filesystem access.

The counter lives at the top level of `backlog.json`:

```json
{
  "version": "1",
  "next_task_seq": 125,
  "epics": [...]
}
```

On every `create_task` call the handler:
1. Reads `next_task_seq` (or bootstraps it if absent)
2. Writes `next_task_seq + 1` back to `backlog.json` atomically
3. Returns the post-write value in the response so the caller can see the next available number immediately

Bootstrap logic (for existing backlogs without the field): scan all `task.ref` values across all epics, extract numeric prefixes matching `task-<N>-`, take max, add 1.

**Affected files:**
- `lib/stateReader.mjs` — new `getNextTaskSeq` helper
- `mcp/handlers.mjs` — `handleCreateTask` (seq read/increment) and `handleGetStatus` (status exposure)
- `mcp/handlers.test.mjs` — new tests
- `.codex/skills/create-task/SKILL.md` and `.claude/skills/create-task/SKILL.md` — Step 0 update

---

## Goals

1. Must store `next_task_seq` as a top-level integer field in `backlog.json`, incremented on every `create_task` call.
2. Must bootstrap `next_task_seq` from existing task refs when the field is absent (scan for `task-<N>-` pattern, take max+1; default to 1 if no numbered refs exist).
3. Must return `next_task_seq` (the incremented value, i.e. the *next* available number after this call) in the `create_task` MCP response.
4. Must expose `next_task_seq` in the `get_status` response.
5. Must update the create-task skill Step 0 to call `mcp__orchestrator__get_status` (or fall back to the shell command if MCP is unavailable), reading `next_task_seq` from the response.

---

## Implementation

### Step 1 — Add getNextTaskSeq helper

**File:** `lib/stateReader.mjs`

```js
const TASK_SEQ_RE = /^task-(\d+)-/;

export function getNextTaskSeq(backlog) {
  if (typeof backlog.next_task_seq === 'number' && backlog.next_task_seq >= 1) {
    return backlog.next_task_seq;
  }
  // Bootstrap: scan all task refs for numeric prefix.
  let max = 0;
  for (const epic of backlog.epics ?? []) {
    for (const task of epic.tasks ?? []) {
      const slug = task.ref?.split('/')[1] ?? '';
      const m = slug.match(TASK_SEQ_RE);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return max + 1;
}
```

### Step 2 — Read, return, and increment seq in handleCreateTask

**File:** `mcp/handlers.mjs`

Inside the `withLock` block, immediately after reading `backlog`:

```js
const currentSeq = getNextTaskSeq(backlog);
backlog.next_task_seq = currentSeq + 1;
// ... existing task creation logic ...
// At the end, atomicWriteJson already saves backlog (including updated next_task_seq).
// Return:
return { ...newTask, next_task_seq: currentSeq + 1 };
// next_task_seq in the response is the NEXT available number (post-increment).
```

Invariant: `atomicWriteJson` is called exactly once (already the case); the seq update is included in the same write — no separate flush needed.

### Step 3 — Expose next_task_seq in handleGetStatus

**File:** `mcp/handlers.mjs`

Add to `handleGetStatus` return value:

```js
const backlog = readJson(stateDir, 'backlog.json');
return {
  agents: [...],
  task_counts: counts,
  active_tasks: activeTasks,
  pending_notifications: pendingNotifications,
  stalled_runs: stalledRuns,
  next_task_seq: getNextTaskSeq(backlog),  // ← add this
};
```

### Step 4 — Update create-task skill Step 0

**Files:** `.codex/skills/create-task/SKILL.md`, `.claude/skills/create-task/SKILL.md`

Replace Step 0 item 1:

```markdown
1. **Determine the next task number:**
   Call `mcp__orchestrator__get_status` and read `next_task_seq` from the response.
   That integer is `<N>` — the next available task number.

   If MCP is unavailable, fall back to:
   ```bash
   # shell fallback (filesystem-based):
   ls docs/backlog/ | grep -oE '^[0-9]+' | sort -n | tail -1 | xargs -I{} expr {} + 1
   ```
```

---

## Acceptance criteria

- [ ] After `create_task` is called, `backlog.json` contains `next_task_seq` incremented by 1.
- [ ] `create_task` response includes `next_task_seq: N` where N is the next available number (post-increment).
- [ ] On a backlog without `next_task_seq`, the first `create_task` call bootstraps correctly from existing `task-<N>-` refs.
- [ ] On a backlog with no numbered refs and no `next_task_seq`, bootstrap returns 1.
- [ ] `get_status` response includes `next_task_seq`.
- [ ] The shell fallback command is retained as a comment in the skill's Step 0.
- [ ] `nvm use 24 && npm run test:orc:mcp && npm run test:orc` passes with no regressions.
- [ ] No changes to files outside the stated scope.

---

## Tests

**File:** `mcp/handlers.test.mjs`:

```js
it('handleCreateTask increments next_task_seq in backlog.json on each call');
it('handleCreateTask returns next_task_seq in response');
it('handleCreateTask bootstraps next_task_seq from existing task refs when field is absent');
it('handleCreateTask sets next_task_seq to 1 when backlog has no numbered refs and field is absent');
```

**File:** `lib/stateReader.test.mjs` (new or extend):

```js
it('getNextTaskSeq returns backlog.next_task_seq when present');
it('getNextTaskSeq bootstraps from task refs when field absent');
it('getNextTaskSeq returns 1 when no numbered refs and field absent');
```

---

## Verification

```bash
nvm use 24 && npm run test:orc:mcp
nvm use 24 && npm run test:orc
```

```bash
npm run orc:doctor
```

## Risk / Rollback

**Risk:** The `next_task_seq` write is bundled into the same `atomicWriteJson` call as the new task — it is never out of sync with the task list. The only risk is if two simultaneous `create_task` calls race; both are inside `withLock`, so only one runs at a time.

**Rollback:** `git restore lib/stateReader.mjs mcp/handlers.mjs .codex/skills/create-task/SKILL.md .claude/skills/create-task/SKILL.md && npm run test:orc:mcp`. The `next_task_seq` field in `backlog.json` can be left as-is or removed manually with `jq 'del(.next_task_seq)'` — existing tasks are unaffected.
