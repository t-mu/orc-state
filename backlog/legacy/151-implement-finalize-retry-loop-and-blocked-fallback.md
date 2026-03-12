---
ref: orch/task-151-implement-finalize-retry-loop-and-blocked-fallback
epic: orch
status: done
---

# Task 151 — Implement Finalize Retry Loop and Blocked Fallback

Depends on Task 150.

## Scope

**In scope:**
- `coordinator.mjs` — attempt trusted merge/finalize actions after the agent reports work complete
- coordinator-to-agent finalize messaging — send finalize-wait and finalize-rebase commands through the existing provider session
- merge retry policy — two finalize retries, then mark blocked while preserving worktree/branch
- coordinator-owned merge and cleanup logic for successful finalization

**Out of scope:**
- Provider launch implementation
- Repo-wide status formatting and operator docs
- Reassignment to a second agent after blocked finalization
- Background garbage collection of stale blocked worktrees

---

## Context

Once the agent can report “work complete, waiting for finalize,” the coordinator needs to own the last mile: attempt merge, detect when `main` has moved, ask the same live agent to rebase again, retry once more if needed, and finally mark the run blocked after two unsuccessful finalize retries.

The user explicitly does not want the work rejected in that case. The fallback must preserve the branch and worktree, not destroy them.

### Current state

The coordinator has no finalization loop. Worker success is treated much closer to terminal completion, and there is no trusted merge owner separate from the agent.

There is also no built-in policy for “try again twice, then preserve and block.”

### Desired state

After the agent reports work complete, the coordinator should try to finalize the branch. If merge cannot proceed because the branch is stale or conflicts remain, the coordinator should send a finalize rebase command back to the same live agent, wait for a new ready-to-merge signal, and retry merge.

After two failed or ignored finalize retries, the coordinator should mark the run blocked and preserve the worktree, branch, and finalization metadata.

### Start here

- `coordinator.mjs` — current dispatch and run lifecycle handling
- `lib/claimManager.mjs` — finalization-phase state from Task 150
- `adapters/pty.mjs` — existing provider session messaging path

<!-- Optional:
### Dependency context

Task 150 adds the state/reporting model for finalization. This task uses that model to implement the actual coordinator-owned finalize loop, including the two-retry blocked fallback.
-->

**Affected files:**
- `coordinator.mjs` — finalize loop, merge attempts, retry counter handling
- coordinator/runtime helper(s) under `lib/` — merge/finalize utilities if extracted
- any touched state helper for preserving worktree/branch metadata and blocked reason
- possibly `adapters/pty.mjs` or messaging helpers if envelope delivery needs small runtime support

---

## Goals

1. Must make the coordinator the trusted owner of final merge and cleanup.
2. Must send finalize rebase requests back to the same live agent when merge cannot proceed cleanly.
3. Must apply exactly two finalize retries before marking the run blocked.
4. Must preserve the branch and worktree when finalization becomes blocked.
5. Must clean up the branch/worktree only after a successful coordinator-owned merge.

---

## Implementation

### Step 1 — Add coordinator-owned finalize messages

**Files:**
- `coordinator.mjs`
- any runtime helper used to build provider session envelopes

Define the structured finalize messages the coordinator sends into the live provider session, including at minimum:
- wait/idle-finalize message
- finalize rebase request
- finalize success/stop message

### Step 2 — Implement the finalize merge loop

**Files:**
- `coordinator.mjs`
- coordinator/runtime helper(s)

When a run enters the finalization phase, attempt merge from trusted coordinator code. This initial merge attempt is retry `0` and does not consume one of the two allowed finalize retries. If merge cannot proceed cleanly, increment the retry counter, send the finalize rebase request to the agent, and wait for the next ready-to-merge signal.

### Step 3 — Apply the two-retry blocked fallback

**Files:**
- `coordinator.mjs`
- touched state helpers

If finalize retry 1 and finalize retry 2 both fail or time out, mark the run blocked. Preserve:
- worktree path
- branch name
- retry count
- last finalization error/reason

Do not reject or delete the work.

### Step 4 — Cleanup only after successful merge

**Files:**
- `coordinator.mjs`
- worktree helper from Task 148

After successful merge, remove the worktree and delete the branch from trusted coordinator code.

---

## Acceptance criteria

- [ ] The coordinator, not the agent, performs the final merge attempt.
- [ ] The coordinator can send finalize rebase requests back to the same live agent.
- [ ] The finalize loop treats the first merge attempt as retry `0`, then applies exactly two finalize retries before marking blocked.
- [ ] Blocked finalization preserves the worktree and branch instead of deleting or rejecting the work.
- [ ] Successful coordinator-owned merge triggers worktree/branch cleanup.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update:

- `orchestrator/coordinator.test.mjs` — assert merge attempt, finalize rebase messaging, retry counting, and blocked fallback
- e2e coverage under `e2e/` — assert a work-complete run can be finalized, retried, and blocked while preserving work metadata

---

## Verification

```bash
# Targeted verification for this task only
npx vitest run -c orchestrator/vitest.config.mjs orchestrator/coordinator.test.mjs
npx vitest run -c orchestrator/vitest.e2e.config.mjs e2e/orchestrationLifecycle.e2e.test.mjs e2e/worker-control-flow.e2e.test.mjs
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

**Risk:** A broken finalize loop can repeatedly spam agents, miscount retries, or accidentally delete preserved work that should have been marked blocked.
**Rollback:** Revert the finalize-loop changes as one unit, preserve existing worktree metadata, and restore manual merge handling until the coordinator path is fixed.
