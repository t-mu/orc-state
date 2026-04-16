---
ref: lifecycle-verbs/177-extract-file-backed-plan-to-backlog-engine
feature: lifecycle-verbs
review_level: full
priority: normal
status: todo
depends_on:
  - lifecycle-verbs/176-add-plan-artifact-contract-and-lookup
---

# Task 177 — Extract File-Backed Plan-to-Backlog Engine

Depends on Task 176. Blocks Tasks 179 and 181.

## Scope

**In scope:**
- Refactor the current `plan-to-tasks` logic into a reusable plan-to-backlog engine that consumes structured parsed-plan input (either from a saved plan file or from a conversationally-extracted plan) rather than reading from conversation context directly.
- Rename the existing `skills/plan-to-tasks/` skill directory to `skills/spec/` and update its content to prefer saved plan artifacts while **retaining the conversational fallback** for agents invoking `/spec` with no saved plan.
- Preserve dependency inference, grouping, preview data preparation, and `create-task`-quality task-shape expectations.
- Add focused tests for engine behavior on parsed plan input.

**Out of scope:**
- Exposing the engine as MCP tools or wiring it into `/spec` (see Task 179).
- Writing backlog task files or syncing them to runtime state.
- Interactive `/plan` authoring.

---

## Context

The existing `skills/plan-to-tasks/SKILL.md` is useful, but it assumes the plan already exists in the current conversation. The approved lifecycle-verbs design flips the source of truth: a saved file in `plans/` becomes the authoritative plan input, and later `/spec plan <id>` flows should reuse one deterministic engine for grouping steps into backlog task specs.

This task isolates that engine so later command routing and publication flows can call it without re-implementing dependency or batching rules.

### Current state

`skills/plan-to-tasks/SKILL.md` mixes three concerns:
- reading a plan from chat context
- inferring grouped backlog tasks and dependencies
- delegating final task-spec authoring

There is no reusable module that takes a parsed plan object and returns a structured batch preview.

### Desired state

A narrow module accepts a parsed saved plan and returns deterministic proposed backlog tasks, dependencies, review levels, and ordering. The prompt-layer skill can be updated to describe the new source model, but the core inference logic should no longer depend on “the most recent printed plan in conversation”.

### Start here

- `skills/plan-to-tasks/SKILL.md` — current behavior and user-facing expectations
- `skills/create-task/SKILL.md` — required task-spec quality bar
- `backlog/21-plan-to-tasks-skill-draft.md` and `backlog/24-plan-to-tasks-review-iterate.md` — prior design intent and evaluation constraints

**Affected files:**
- `lib/planToBacklog.ts` — new reusable engine module
- `lib/planToBacklog.test.ts` — saved-plan grouping and dependency tests
- `skills/spec/SKILL.md` — renamed from `skills/plan-to-tasks/SKILL.md`; describes the new file-backed primary path with a retained conversational fallback
- `skills/orc-commands/SKILL.md` — update any references from `plan-to-tasks` to `spec`
- `docs/cli.md` — reflect the renamed skill and the engine contract

---

## Goals

1. Must accept structured parsed plan input rather than reading from conversation context.
2. Must preserve dependency inference based on actual implementation need, not raw list order.
3. Must support grouping multiple implementation steps into one backlog task when the boundaries are tighter than one-step-per-task.
4. Must produce a stable in-memory preview model that later `/spec plan <id>` routing can render before confirmation.
5. Must keep the output aligned with `create-task` section expectations so downstream task writing stays high-quality.

---

## Implementation

### Step 1 — Extract a pure generation contract

**File:** `lib/planToBacklog.ts`

Implement a pure function that accepts a parsed plan and returns a batch model such as:

```ts
type ProposedTask = {
  title: string;
  slug: string;
  description: string;
  dependsOn: string[];
  reviewLevel: 'none' | 'light' | 'full';
  stepNumbers: number[];
  feature: string;   // propagated from plan.name for every generated task
};
```

The `reviewLevel` values MUST match the repo-wide enum used by `lib/backlogSync.ts` (`'none' | 'light' | 'full'`). Do not introduce a new vocabulary.

The engine MUST stamp every proposed task with `feature: <plan.name>` so downstream publication produces backlog specs that sync cleanly.

Keep preview rendering, confirmation, and file writes outside this module.

### Step 2 — Rename the skill and reconcile it with the new source model

Rename `skills/plan-to-tasks/` → `skills/spec/`. This is the user-facing skill directory for the `/spec` verb that later tasks (179) wire to MCP tools.

**File:** `skills/spec/SKILL.md` (renamed from `skills/plan-to-tasks/SKILL.md`)

Update the skill instructions so:
- **Saved plan artifacts are the preferred source.** `/spec plan <id>` reads `plans/<plan_id>-*.md` via the Task 176 lookup, parses it, and feeds the engine.
- **Conversational plans remain a supported fallback.** `/spec` (no args) reads the most recent plan printed in conversation, structures it into the plan artifact shape, and feeds the engine. This path remains useful for quick ad-hoc turns and does not require a saved plan file.
- The skill is agent-agnostic — any agent (not only the master) may invoke it; do not add master-specific framing.
- The skill describes the engine contract (`ProposedTask`) so the model knows what shape to expect from the engine before `/spec` is wired to MCP tools in Task 179.

Update any references in `skills/orc-commands/SKILL.md` and `docs/cli.md` from `plan-to-tasks` to `spec`.

### Step 3 — Test grouping and dependency inference

**File:** `lib/planToBacklog.test.ts`

Add cases for:
- linear dependency chains
- independent parallelizable steps
- explicit dependency cues overriding naive adjacency
- grouped multi-step tasks
- single-step plans staying independent

---

## Acceptance criteria

- [ ] The reusable engine accepts parsed plan input (saved or conversational) and returns proposed backlog tasks without reading conversation state directly.
- [ ] Every `ProposedTask` carries `feature: <plan.name>` and a `reviewLevel` in `'none' | 'light' | 'full'`.
- [ ] Dependency inference and grouping behavior are covered by tests.
- [ ] The engine output is sufficient for a preview step before any task-spec files are written.
- [ ] `skills/plan-to-tasks/` has been renamed to `skills/spec/` and its content describes file-backed as primary with the conversational fallback explicitly retained.
- [ ] `skills/orc-commands/SKILL.md` and `docs/cli.md` reflect the rename.
- [ ] The skill contains no master-specific framing.
- [ ] No command routing, worktree creation, or backlog publication happens in this task.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/planToBacklog.test.ts`:

```ts
it('creates a linear dependency chain from saved plan steps', () => { ... });
it('keeps independent steps parallel when no dependency exists', () => { ... });
it('uses explicit dependency cues from the plan artifact', () => { ... });
it('groups tightly coupled steps into one proposed backlog task', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/planToBacklog.test.ts
```

```bash
nvm use 24 && npm test
```
