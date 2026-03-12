---
ref: orch/task-154-worker-sets-status-done-on-merge
epic: orch
status: done
---

# Task 154 — Worker Sets Status Done on Merge

Depends on Task 153. Blocks nothing directly.

## Scope

**In scope:**
- Edit the "Finish" section of `AGENTS.md`: add an explicit step before `git add -p` instructing the worker to edit its task's spec file, changing `status: todo` → `status: done`.
- Find all worker bootstrap template files in `templates/` and add the same instruction in the matching finish/merge section.

**Out of scope:**
- Orchestrator coordinator source code — no changes to `coordinator.mjs` or any `.mjs` file.
- Master bootstrap template (master does not execute tasks and does not merge worktrees on behalf of workers).
- Reviewer bootstrap templates.
- `scripts/backlog_sync_check.mjs` — covered in Task 156.

---

## Context

### Current state

The worker workflow in `AGENTS.md` (Finish section) has workers commit their implementation, run a review round, rebase, merge to main, and clean up. There is no step to update the task's spec file `status:` field. As a result, even after Task 153 adds `status:` fields, those fields stay permanently at `status: todo` — they are never flipped to `done` when work lands.

### Desired state

A worker's merge commit atomically includes two things: the implementation changes AND the one-line frontmatter edit that flips `status: todo` → `status: done` in the task's spec file. The `status:` value on `main` is always accurate without any coordinator involvement.

### Start here

- `AGENTS.md` — "Finish — after all acceptance criteria are met" section
- `templates/` — list all files, find the worker bootstrap template

**Affected files:**
- `AGENTS.md` — add status-update step to finish workflow
- `templates/<worker-bootstrap-file>` — add same instruction

---

## Goals

1. Must add a step to `AGENTS.md` finish workflow that edits the spec file's `status: todo` → `status: done` before the `git add -p` commit step.
2. Must add the same step to the worker bootstrap template(s) in `templates/`.
3. Must specify the exact location of the spec file (e.g. `docs/backlog/<N>-<slug>.md` matching the task's ref).
4. Must not modify any file other than `AGENTS.md` and the identified template file(s).
5. Must leave all other workflow steps in `AGENTS.md` unchanged.

---

## Implementation

### Step 1 — Identify the worker bootstrap template

**File:** `templates/` (list contents first)

```bash
ls templates/
```

Find the file used for worker agent bootstrap (likely named something like `worker-bootstrap.txt` or `WORKER_BOOTSTRAP.md`). Read it to find the "Finish" or merge section.

### Step 2 — Update `AGENTS.md` finish workflow

**File:** `AGENTS.md`

In the "Finish — after all acceptance criteria are met" section, insert a new step **before** the `git add -p` step:

```markdown
### Finish — after all acceptance criteria are met
```bash
# 0. Mark the task spec as done (must be part of the implementation commit)
#    Edit docs/backlog/<N>-<slug>.md — the spec file for this task's ref.
#    Change the frontmatter line:  status: todo  →  status: done
#    The file is at docs/backlog/ with the filename matching the task ref slug.

# 1. Commit inside the worktree
git add -p
git commit -m "feat(<scope>): <outcome>"
```

The edit is intentionally part of the same commit as the implementation — not a separate commit. The `git add -p` will include it when the worker stages the spec file.

### Step 3 — Update worker bootstrap template

**File:** `templates/<worker-bootstrap-file>`

Locate the equivalent finish/merge section in the template. Add the same instruction immediately before the commit step, using the same wording as Step 2 for consistency.

---

## Acceptance criteria

- [ ] `AGENTS.md` finish section contains a step to edit `status: todo` → `status: done` in the task's spec file before committing.
- [ ] The step is positioned before the `git add -p` line.
- [ ] The worker bootstrap template in `templates/` contains the equivalent step.
- [ ] The instruction names the correct file path pattern (`docs/backlog/<N>-<slug>.md`).
- [ ] No other sections of `AGENTS.md` are modified.
- [ ] No orchestrator `.mjs` source files are modified.
- [ ] No changes to files outside `AGENTS.md` and `templates/`.

---

## Tests

No automated tests — this task edits documentation and instruction templates. Verification is by inspection.

---

## Verification

```bash
# Confirm the status-update step is present in AGENTS.md
grep -n "status: done\|status: todo" AGENTS.md
# Expected: at least one line referencing the status flip

# Confirm the worker template also has the instruction
grep -rn "status: done\|status: todo" templates/
# Expected: at least one match
```

```bash
nvm use 24 && npm run build
nvm use 24 && npm test
```
