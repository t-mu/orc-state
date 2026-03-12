---
ref: orch/task-149-shift-agent-workflow-to-coordinator-owned-finalization
epic: orch
status: done
---

# Task 149 — Shift Agent Workflow to Coordinator-Owned Finalization

Depends on Task 148.

## Scope

**In scope:**
- `AGENTS.md` — remove agent-owned worktree creation, merge, and cleanup from the standard workflow
- `templates/worker-bootstrap-v2.txt` — update worker instructions to assume the session already starts inside the assigned worktree
- `templates/task-envelope-v2.txt` — add explicit finalize-wait / finalize-rebase expectations
- reporting CLIs and validation helpers under `cli/` and `lib/` only as needed to add the first non-terminal “work complete / awaiting finalize” signal
- any bootstrap/session helper touched to render the updated workflow contract

**Out of scope:**
- Finalization retry counters and blocked-preservation policy
- Coordinator merge logic
- Status output and operator docs beyond what the new workflow contract requires
- Provider launch implementation

---

## Context

Today the agent workflow still assumes full git lifecycle ownership: create a worktree, do the task, rebase, merge into `main`, and delete the worktree. That is too much trusted workflow responsibility for the agent, and it conflicts with the desired model where the coordinator owns final merge and cleanup.

After Task 148, provider sessions will already start in an assigned worktree. The next step is to update agent instructions so the agent focuses on code work, commit/rebase preparation, and responding to coordinator finalization messages instead of performing merge/deletion itself.

### Current state

`AGENTS.md` and `worker-bootstrap-v2.txt` tell the agent to create the worktree, merge into `main`, and remove the worktree/branch when done.

There is no explicit “work complete, remain alive, wait for coordinator finalization” contract, and there is no first-class non-terminal signal for that handoff.

### Desired state

The agent should assume it already starts inside the correct worktree. It should do the task work, commit, run review/verification, rebase onto `main`, then report a non-terminal “work complete / awaiting finalize” signal and remain alive waiting for either:
- a finalize success/stop message
- or a finalize rebase request from the coordinator

Merge to `main` and worktree cleanup should move out of the agent instructions completely.

### Start here

- `AGENTS.md` — current worktree/rebase/merge/cleanup workflow
- `templates/worker-bootstrap-v2.txt` — current worker contract
- `templates/task-envelope-v2.txt` — current task handoff contract

<!-- Optional:
### Dependency context

Task 148 moves provider launch into a coordinator-assigned worktree. This task updates the agent contract to match that new reality, and adds the minimal non-terminal handoff signal needed so workers can wait for coordinator-owned finalization without misusing `run-finish`.
-->

**Affected files:**
- `AGENTS.md` — repo-wide worker expectations
- `templates/worker-bootstrap-v2.txt` — worker lifecycle contract
- `templates/task-envelope-v2.txt` — task handoff and finalization wait/rebase instructions
- reporting CLIs/validation helpers under `cli/` and `lib/` — minimal work-complete handoff signal
- `lib/sessionBootstrap.mjs` if helper changes are needed to render the new contract

---

## Goals

1. Must remove agent-owned worktree creation from the standard workflow.
2. Must remove agent-owned merge and worktree cleanup from the standard workflow.
3. Must retain agent-owned commit, review, verification, and `git rebase main`.
4. Must introduce an explicit “remain alive and wait for coordinator finalization” contract.
5. Must introduce the minimal non-terminal reporting signal needed for that wait state.
6. Must make no provider-specific assumptions outside the adapter layer.

---

## Implementation

### Step 1 — Rewrite the repo-level workflow contract

**File:** `AGENTS.md`

Update the standard workflow so the agent assumes:
- it is already inside the assigned worktree
- merge and cleanup are coordinator-owned
- the agent stops at `ready_for_merge` / `work_complete` and waits for finalization messages

Keep `git rebase main` in the agent-owned flow.

### Step 2 — Rewrite the worker bootstrap contract

**File:** `templates/worker-bootstrap-v2.txt`

Replace worktree-creation and self-merge instructions with finalization-wait behavior. The bootstrap should clearly distinguish:
- initial task work
- finalization wait
- finalize rebase request handling

### Step 3 — Update task-envelope instructions

**File:** `templates/task-envelope-v2.txt`

Add explicit wording that the worker remains alive after work completion and may receive a follow-up coordinator command to rebase again before merge.

### Step 4 — Add the first non-terminal handoff signal

**Files:**
- reporting CLIs under `cli/`
- touched validation helpers under `lib/`

Add the minimal reporting support needed for the worker to signal “work complete / awaiting finalize” without using a terminal success event. Leave retry accounting and blocked finalization policy to later tasks.

---

## Acceptance criteria

- [ ] Agent instructions no longer require creating a worktree manually.
- [ ] Agent instructions no longer require merging to `main` or deleting the worktree/branch.
- [ ] Agent instructions still require commit/review/verification and `git rebase main`.
- [ ] The workflow explicitly tells the agent to remain alive and wait for coordinator finalization messages.
- [ ] The worker has a non-terminal reporting signal for “work complete / awaiting finalize”.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update:

- `lib/sessionBootstrap.test.mjs` — assert the worker bootstrap reflects coordinator-owned finalization
- template/render tests near `task-envelope-v2.txt` — assert finalize wait/rebase instructions are present
- `cli/run-reporting.test.mjs` — assert the non-terminal work-complete handoff signal is accepted

---

## Verification

```bash
# Targeted verification for this task only
npx vitest run -c orchestrator/vitest.config.mjs lib/sessionBootstrap.test.mjs lib/templateRender.test.mjs
```

```bash
# Final required repo-wide checks before marking the task done
nvm use 24 && npm run build
nvm use 24 && npm test
```

```bash
# Smoke checks — include only when schema, state, or CLI changes are in scope
node cli/orc.mjs doctor
node cli/orc.mjs status
# Expected: exits 0, no validation errors
```

---

## Risk / Rollback

**Risk:** If the instructions change before the coordinator finalization path exists, agents can stop too early or wait for messages that are never sent.
**Rollback:** Revert the bootstrap/instruction changes together and restore the previous self-finalizing workflow until the runtime support lands.
