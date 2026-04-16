---
ref: lifecycle-verbs/179-implement-spec-task-from-saved-plans
feature: lifecycle-verbs
review_level: full
priority: high
status: todo
depends_on:
  - lifecycle-verbs/176-add-plan-artifact-contract-and-lookup
  - lifecycle-verbs/177-extract-file-backed-plan-to-backlog-engine
  - lifecycle-verbs/180-implement-interactive-plan-authoring-workflow
---

# Task 179 — Implement /spec from Saved Plans (with Conversational Fallback)

Depends on Tasks 176, 177, and 180. Blocks Task 181.

## Scope

**In scope:**
- Add MCP tools `spec_preview` and `spec_publish` that any agent can invoke to turn a saved plan artifact into backlog task specs.
- Extend `skills/spec/SKILL.md` (renamed in Task 177) to drive the preview → confirm → publish flow via those tools, handling both invocation forms:
  - `/spec plan <id>` — load the saved plan artifact at `plans/<id>-*.md`
  - `/spec` (no args) — conversational fallback: structure the most recently printed plan from the chat, persist it via `plan_write` (Task 180) so every plan flows through the same file-backed contract, then continue with preview/publish
- Implement staging, batch publication, and `derived_task_refs` writeback for successful runs — all within the invoking agent's dedicated worktree.
- Update AGENTS.md, `skills/orc-commands/SKILL.md`, and `docs/cli.md` so the `/spec` verb and its MCP tools are documented alongside this change.

**Out of scope:**
- Generic workflow-control-plane abstractions for arbitrary verbs.
- Interactive `/plan` authoring (see Task 180).
- Automatically regenerating tasks from a plan whose `derived_task_refs` is already populated. A plan with non-empty `derived_task_refs` hard-fails; regeneration is a separate future task.

---

## Context

The approved rollout starts with `/spec` because it proves the plan-backed flow without needing the full interactive planning workflow first. Any agent (master, worker, automation) can invoke `/spec` to turn a plan into backlog specs deterministically, with a preview step and explicit confirmation before any backlog files become visible.

The verbs are **agent-agnostic** — the master is simply the user-facing entry point for the framework. The MCP tools exposed here have no "master" affinity; any caller can invoke them.

### Worktree model

The invoking agent MUST run `/spec` inside a fresh worktree (see the worker worktree workflow in AGENTS.md). The `spec_publish` MCP tool writes spec files and updates the plan **only within that worktree**. It does not touch the main checkout or the coordinator's shared state (`.orc-state/backlog.json`). Publication happens via the standard worktree workflow:

1. `spec_publish` writes files to the worktree's `backlog/` and updates the worktree's `plans/<id>-*.md` with `derived_task_refs`.
2. The skill commits the changes in the worktree.
3. The skill merges the worktree to main following the AGENTS.md cleanup ordering (merge → branch delete → worktree remove).

After merge, the coordinator's auto-sync tick picks up the new specs from main's `backlog/` and creates any missing feature record automatically. The skill does not need to call `orc backlog-sync-check` — runtime state is the coordinator's responsibility. Any agent or operator may run `orc backlog-sync-check` ad-hoc to verify, but it is not part of the verb's flow.

This matches how workers already create and land tasks; no coordinator-state race is possible because all state-mutating work happens in the worktree, and main is reached only through merge.

### Conversational fallback

When invoked as `/spec` with no plan id, the skill reads the most recent plan printed in conversation, asks the model to structure it into the Task 176 plan artifact shape, and calls `plan_write` (from Task 180) to persist it into the worktree's `plans/` directory. All plans flow through the same file-backed contract — the fallback is just "author a plan first, then spec it" — so the engine, MCP tools, and sync logic remain uniform.

### Current state

There is no MCP surface for plan-backed task generation, no batch staging area, no `/spec` skill wired to MCP tools, and no code that writes successful task refs back into a plan's `derived_task_refs`.

### Desired state

Any agent can invoke `spec_preview(plan_id)` and `spec_publish(plan_id, confirm: true)` inside a worktree, commit the result, and merge to main. The coordinator's auto-sync picks up the new specs from main on its next tick. The `/spec` skill handles both the saved-plan and conversational-fallback invocation forms uniformly.

### Start here

- `lib/planDocs.ts` — plan lookup and validation from Task 176
- `lib/planToBacklog.ts` — generation engine from Task 177
- `skills/spec/SKILL.md` — renamed skill from Task 177; extend it here
- `mcp/handlers.ts` — existing MCP tool registry; add the new handlers here
- `mcp/server.ts` — tool transport wiring
- `lib/backlogSync.ts` — existing sync path that handles feature creation during coordinator ticks
- `cli/backlog-sync-check.ts` — scoped sync semantics (accepts `--refs=`)

**Affected files:**
- `lib/planSpecTask.ts` — orchestrate lookup, engine, staging, file writes, plan writeback (worktree-local only)
- `lib/planSpecTask.test.ts` — end-to-end unit/integration coverage
- `mcp/handlers.ts` — add `spec_preview` and `spec_publish` handlers
- `mcp/handlers.test.ts` — handler coverage
- `mcp/server.ts` — register the new tools on the transport
- `skills/spec/SKILL.md` — extend for MCP invocation and conversational fallback
- `AGENTS.md` — add lifecycle-verbs section referencing `/spec`
- `skills/orc-commands/SKILL.md` — document `spec_preview` and `spec_publish` MCP tools and `/spec` skill
- `docs/cli.md` — user-visible `/spec` documentation

---

## Goals

1. Must resolve plan files only by numeric `plan_id` and fail clearly on missing or duplicate matches (via Task 176 helpers).
2. Must split into two MCP tools: `spec_preview(plan_id)` (pure read) and `spec_publish(plan_id, confirm: true)` (side-effecting within the worktree).
3. `spec_publish` MUST hard-fail if `confirm` is not the literal boolean `true`.
4. Must stage generated files under `.orc-state/plan-staging/<plan_id>/` before writing into the worktree's `backlog/`. The staging `mkdir` acts as the concurrency lock: a second concurrent publish attempt on the same `plan_id` must fail because the directory already exists.
5. All file writes (backlog specs, plan-file `derived_task_refs` update) happen **inside the worktree only**. The MCP tool does not mutate main or `.orc-state/backlog.json`.
6. The skill handles commit and merge-to-main per AGENTS.md. It does NOT call `orc backlog-sync-check` — runtime state is the coordinator's responsibility. Any caller wanting to verify can run the sync-check ad-hoc, but it is not part of the verb's flow.
7. Must write `derived_task_refs` back into the worktree plan file only after all staged specs have been written successfully.
8. Must **hard-fail** (no override flag) when `derived_task_refs` is already non-empty on the target plan. Regeneration is a future task.
9. Must **hard-fail** (no override flag) when a stale staging directory already exists for the same `plan_id`.
10. Feature record for `plan.name` is created automatically by the coordinator's auto-sync after merge. The MCP tool MUST NOT call `ensureFeature` directly and MUST NOT mutate `.orc-state/backlog.json`.
11. The `/spec` skill is agent-agnostic. It MUST include the standard worktree instruction: *"Run this verb inside a fresh worktree per the worker worktree workflow in AGENTS.md. Commit, merge to main, and clean up in the order AGENTS.md specifies."*
12. The `/spec` skill MUST support both invocation forms: `/spec plan <id>` and `/spec` (conversational).
13. Must NOT introduce a generic workflow-control-plane abstraction.
14. Must update AGENTS.md (lifecycle-verbs section), `skills/orc-commands/SKILL.md` (MCP tool + skill reference), and `docs/cli.md` (user-visible verb docs) in this task.

---

## Implementation

### Step 1 — Add the orchestration module

**File:** `lib/planSpecTask.ts`

Implement two exported functions matching the MCP surface:

```ts
export async function previewSpec(planId: number): Promise<SpecPreview>;
export async function publishSpec(planId: number, opts: { confirm: true }): Promise<SpecResult>;
```

`previewSpec` is pure: it resolves the plan (from the worktree's `plans/`), runs the engine, returns the proposed batch. Zero side effects.

`publishSpec` performs the full flow **within the current worktree**:
1. Validate `confirm === true`.
2. Resolve and validate the plan; hard-fail on non-empty `derived_task_refs`.
3. Atomic `mkdir` of `.orc-state/plan-staging/<plan_id>/`; hard-fail if the directory already exists.
4. Run the engine; write staged spec files.
5. Move staged spec files atomically into the worktree's `backlog/`.
6. Update the worktree's `plans/<id>-*.md` with `derived_task_refs` atomically.
7. Clean up the staging directory only after the full flow succeeds.

The tool returns the list of created refs and the plan file path. It does NOT touch git, merge, or the coordinator's shared state — those are the skill's responsibility.

If anything fails after step 5 begins, report the exact visible refs/files and leave `derived_task_refs` unchanged.

### Step 2 — Expose MCP tools

**File:** `mcp/handlers.ts`

Add two handlers that delegate to `lib/planSpecTask.ts`:
- `spec_preview` — input `{ plan_id: number }`, output the preview model.
- `spec_publish` — input `{ plan_id: number, confirm: true }`, output the publish result (created refs + plan path).

**File:** `mcp/server.ts`

Register the new tools on the transport following existing patterns.

### Step 3 — Extend the skill

**File:** `skills/spec/SKILL.md` (already renamed in Task 177)

Add the full invocation workflow. The skill must:

- Instruct the invoker to run inside a fresh worktree (reference AGENTS.md).
- Handle two invocation forms:
  - **`/spec plan <id>`**: call `spec_preview(id)`, show the proposal, obtain confirmation, call `spec_publish(id, confirm: true)`.
  - **`/spec` (no args, conversational fallback)**: extract the most recently printed plan from the chat; structure it into the plan artifact shape; call `plan_write(...)` (Task 180) to persist it into the worktree's `plans/`, capturing the returned `plan_id`; then continue as above.
- After `spec_publish` returns, instruct the agent to:
  1. `git add` the new backlog specs and the updated plan file.
  2. `git commit` in the worktree.
  3. Merge the worktree to main following AGENTS.md cleanup ordering. The coordinator's auto-sync tick handles runtime state; the skill does not call `orc backlog-sync-check`.

### Step 4 — Document the new surface

- **`AGENTS.md`** — add a short "Lifecycle verbs" section describing `/plan` and `/spec` as agent-agnostic MCP-backed workflows, the `plans/` artifact directory, and the worktree + merge-to-main expectation.
- **`skills/orc-commands/SKILL.md`** — list `spec_preview` and `spec_publish` MCP tools and reference the `/spec` skill.
- **`docs/cli.md`** — user-visible description of the `/spec` verb and both invocation forms.

### Step 5 — Cover staging, publication, and failure modes

**File:** `lib/planSpecTask.test.ts` and `mcp/handlers.test.ts`

Add tests for:
- `previewSpec` is pure and returns the proposal without publication
- `publishSpec` without `confirm: true` hard-fails
- Positive publication: files appear under the worktree's `backlog/`, `feature: <plan.name>` is set on every generated spec, `derived_task_refs` is written
- Stale staging directory rejection (pre-existing `.orc-state/plan-staging/<plan_id>/`)
- Concurrent publish on the same `plan_id` — second caller fails because `mkdir` is the lock
- Pre-existing non-empty `derived_task_refs` — hard fail
- `publishSpec` does NOT call `ensureFeature`, does NOT write to `.orc-state/backlog.json`, and does NOT perform git operations
- Partial publication reporting: when some files write and one fails, the error names the visible refs; `derived_task_refs` is NOT written

---

## Acceptance criteria

- [ ] `spec_preview(plan_id)` returns the proposal with zero side effects.
- [ ] `spec_publish(plan_id, { confirm: true })` writes to the worktree only; `confirm !== true` hard-fails.
- [ ] `spec_publish` does not touch `.orc-state/backlog.json`, git, or any file outside the worktree.
- [ ] Generated specs are staged under `.orc-state/plan-staging/<plan_id>/` before entering the worktree's `backlog/`; staging `mkdir` acts as the concurrency lock.
- [ ] Every generated backlog spec carries `feature: <plan.name>` and a valid `review_level` in `'none' | 'light' | 'full'`.
- [ ] `derived_task_refs` is updated in the worktree plan file only after full publication succeeds.
- [ ] Pre-existing non-empty `derived_task_refs` and stale staging directories both hard-fail with no override.
- [ ] MCP tools are registered in `mcp/handlers.ts` and `mcp/server.ts` with matching tests in `mcp/handlers.test.ts`.
- [ ] `skills/spec/SKILL.md` supports both `/spec plan <id>` and `/spec` (conversational fallback) invocation forms and includes the worktree + merge-to-main instruction. The skill does NOT call `orc backlog-sync-check` — runtime state is coordinator-owned.
- [ ] `AGENTS.md`, `skills/orc-commands/SKILL.md`, and `docs/cli.md` describe the new verb and MCP tools.
- [ ] No generic workflow-control-plane abstraction is introduced.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/planSpecTask.test.ts`:

```ts
it('previewSpec returns the proposal without side effects', () => { ... });
it('publishSpec hard-fails when confirm is not true', () => { ... });
it('publishSpec writes backlog specs with feature: <plan.name> into the worktree', () => { ... });
it('publishSpec does not touch .orc-state/backlog.json or invoke git', () => { ... });
it('rejects stale staging directories for the same plan id', () => { ... });
it('rejects concurrent publish on the same plan id (mkdir lock)', () => { ... });
it('fails when the plan already has derived_task_refs', () => { ... });
it('leaves derived_task_refs unchanged on partial publication failure', () => { ... });
```

Add to `mcp/handlers.test.ts`:

```ts
it('spec_preview MCP handler returns a proposal', () => { ... });
it('spec_publish MCP handler requires confirm: true', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/planSpecTask.test.ts lib/planToBacklog.test.ts lib/planDocs.test.ts mcp/handlers.test.ts
```

```bash
nvm use 24 && npm test
```

```bash
orc backlog-sync-check --refs=lifecycle-verbs/179-implement-spec-task-from-saved-plans
```

---

## Risk / Rollback

**Risk:** Publication failure mid-flight could leave partially visible spec files in the worktree's `backlog/` that later merge to main looking complete to the coordinator.
**Rollback:** git restore mcp/server.ts mcp/handlers.ts lib/planSpecTask.ts lib/planSpecTask.test.ts skills/spec/ AGENTS.md skills/orc-commands/SKILL.md docs/cli.md && rm -rf .orc-state/plan-staging && npm test
