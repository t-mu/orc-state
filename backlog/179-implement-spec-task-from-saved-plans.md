---
ref: lifecycle-verbs/179-implement-spec-task-from-saved-plans
feature: lifecycle-verbs
review_level: full
priority: high
status: todo
depends_on:
  - lifecycle-verbs/176-add-plan-artifact-contract-and-lookup
  - lifecycle-verbs/177-extract-file-backed-plan-to-backlog-engine
  - lifecycle-verbs/178-add-master-worktree-lifecycle-for-lifecycle-verbs
---

# Task 179 — Implement /spec task <id> from Saved Plans

Depends on Tasks 176, 177, and 178. Blocks Tasks 180 and 181.

## Scope

**In scope:**
- Add the first concrete lifecycle verb: `/spec task <id>`.
- Load and validate a saved plan artifact by numeric `plan_id`, generate a preview from the reusable engine, require explicit confirmation, then create backlog task specs from that plan.
- Implement staging, batch publication, scoped backlog sync-check, and `derived_task_refs` writeback for successful runs.

**Out of scope:**
- Generic workflow-control-plane abstractions for arbitrary verbs.
- Interactive `/plan` authoring.
- Automatically regenerating tasks from a plan whose `derived_task_refs` is already populated.

---

## Context

The approved rollout starts with `/spec task <id>` because it proves the plan-backed flow without needing the full interactive planning workflow first. Once a saved plan exists, the master should be able to turn it into backlog specs deterministically, inside a dedicated master worktree, with a preview and explicit confirmation before any backlog files become visible.

This task is the bridge between the saved `plans/` contract and actual backlog task-spec creation.

### Current state

There is no command path that recognizes `/spec task <id>`, no batch staging area for generated task specs, no scoped sync-check tied to created refs, and no code that writes successful task refs back into a plan’s `derived_task_refs`.

### Desired state

The master can execute `/spec task 42`, resolve exactly one plan file, show a task-generation preview, and on confirmation stage and publish a full batch of `backlog/*.md` specs using `feature: <plan.name>`. Partial publication is reported explicitly, stale staging blocks reuse, and `derived_task_refs` is written only after publication and scoped sync-check both succeed.

### Start here

- `lib/planDocs.ts` — plan lookup and validation from Task 176
- `lib/planToBacklog.ts` — generation engine from Task 177
- `lib/masterWorktree.ts` — worktree lifecycle from Task 178
- `templates/master-bootstrap-v1.txt` — master command guidance

**Affected files:**
- `mcp/server.ts` — add or expose a narrow `/spec task <id>` execution path if tool support is needed
- `lib/planSpecTask.ts` — orchestrate lookup, preview, confirmation, staging, publication, and writeback
- `lib/planSpecTask.test.ts` — end-to-end unit/integration coverage for generation flow
- `templates/master-bootstrap-v1.txt` — teach the master how to route `/spec task <id>`

---

## Goals

1. Must resolve plan files only by numeric `plan_id` and fail clearly on missing or duplicate matches.
2. Must show a preview before writing any backlog task files.
3. Must accept only explicit affirmative confirmation such as `confirm`, `yes`, or `proceed`.
4. Must stage generated files under `.orc-state/plan-staging/<plan_id>/` before batch publication into `backlog/`.
5. Must run `orc backlog-sync-check --refs=<full-created-refs>` after publication and treat that as part of success.
6. Must write `derived_task_refs` back into the plan only after publication and scoped sync-check both succeed.
7. Must fail by default when `derived_task_refs` is already non-empty.
8. Must fail by default when a stale staging directory already exists for the same `plan_id`.

---

## Implementation

### Step 1 — Add the `/spec task <id>` execution flow

**File:** `lib/planSpecTask.ts`

Implement a single orchestration path that:
- acquires the dedicated master worktree
- resolves and validates the plan
- runs the plan-to-backlog engine
- renders a preview model
- waits for explicit confirmation
- writes staged files
- publishes the full batch into `backlog/`
- runs scoped sync-check
- writes `derived_task_refs`

Keep all-or-nothing semantics around success reporting. If anything fails after publication begins, report the exact visible refs/files and leave `derived_task_refs` unchanged.

### Step 2 — Wire the master entrypoint

**File:** `templates/master-bootstrap-v1.txt`

Add explicit routing guidance for the literal command form `/spec task <id>`. Reuse the existing master command interpretation path instead of adding provider-specific slash-command config files.

**File:** `mcp/server.ts`

If a narrow tool is required for reliable invocation, add only the specific `/spec task <id>` flow surface needed here; do not introduce a generic workflow engine in this task.

### Step 3 — Cover staging, publication, and failure modes

**File:** `lib/planSpecTask.test.ts`

Add tests for:
- preview without publication before confirmation
- positive confirmation
- non-affirmative cancellation
- stale staging directory rejection
- partial publication reporting
- `derived_task_refs` writeback only on success

---

## Acceptance criteria

- [ ] `/spec task <id>` resolves and validates a saved plan artifact by numeric `plan_id`.
- [ ] A preview is shown before any backlog files are published.
- [ ] Only explicit affirmative confirmation triggers publication.
- [ ] Generated specs are staged under `.orc-state/plan-staging/<plan_id>/` before entering `backlog/`.
- [ ] `orc backlog-sync-check --refs=<full-created-refs>` runs after publication and gates success.
- [ ] `derived_task_refs` is updated only after full publication and scoped sync-check success.
- [ ] Existing non-empty `derived_task_refs` and stale staging directories both fail by default.
- [ ] No generic workflow-control-plane abstraction is introduced.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/planSpecTask.test.ts`:

```ts
it('shows a preview before publication', () => { ... });
it('publishes generated backlog specs only after explicit confirmation', () => { ... });
it('rejects stale staging directories for the same plan id', () => { ... });
it('leaves derived_task_refs unchanged when sync-check fails', () => { ... });
it('fails when the plan already has derived_task_refs', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/planSpecTask.test.ts lib/planToBacklog.test.ts lib/planDocs.test.ts
```

```bash
nvm use 24 && npm test
```

```bash
orc backlog-sync-check --refs=lifecycle-verbs/179-implement-spec-task-from-saved-plans
```

---

## Risk / Rollback

**Risk:** Publication or sync failure after some files become visible in `backlog/` could leave a partially generated task batch that looks complete to the coordinator.
**Rollback:** git restore mcp/server.ts lib/planSpecTask.ts lib/planSpecTask.test.ts templates/master-bootstrap-v1.txt && rm -rf .orc-state/plan-staging && npm test
