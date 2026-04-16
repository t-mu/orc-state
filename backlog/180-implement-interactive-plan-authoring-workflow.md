---
ref: lifecycle-verbs/180-implement-interactive-plan-authoring-workflow
feature: lifecycle-verbs
review_level: full
priority: normal
status: todo
depends_on:
  - lifecycle-verbs/176-add-plan-artifact-contract-and-lookup
---

# Task 180 — Implement Interactive /plan Authoring Workflow

Depends on Task 176. Blocks Task 181.

## Scope

**In scope:**
- Add MCP tool `plan_write` that any agent can invoke to persist a fully-specified plan artifact.
- Add a `/plan` skill under `skills/plan/` that guides the invoking agent to reduce ambiguity through follow-ups until the required sections are concrete, then calls `plan_write` to persist the artifact.
- Auto-derive `plan_id` (via Task 176's `nextPlanId()`), `name`, and `title` from the user request.
- Update AGENTS.md, `skills/orc-commands/SKILL.md`, and `docs/cli.md` so the `/plan` verb and its MCP tool are documented alongside this change.

**Out of scope:**
- Regenerating backlog task specs automatically after a plan changes.
- Generic multi-verb workflow abstractions beyond `/plan`.
- Executing backlog tasks or delegating workers directly from the `/plan` flow.
- Programmatically resuming an existing plan for in-place edits.

---

## Context

Once `/spec` exists, the second phase is the authoring side: `/plan` should let the invoking agent (master when user-facing, worker or automation otherwise) explore a request, ask only the high-value follow-ups needed to remove ambiguity, and persist a definitive planning artifact for later `/spec plan <id>` conversion.

The saved plan is not a discussion log. It is an authoritative machine-consumable guide that later agents can use without re-reading the full conversation.

The verbs are **agent-agnostic** — the master is simply the user-facing entry point for the framework. The MCP tool exposed here has no "master" affinity; any caller can invoke it.

### Worktree model

The invoking agent MUST run `/plan` inside a fresh worktree (see the worker worktree workflow in AGENTS.md). `plan_write` writes the plan artifact **only within that worktree**. It does not mutate main or coordinator shared state. Publication to main happens via the standard worktree workflow:

1. `plan_write` writes `plans/<plan_id>-<slug>.md` atomically in the worktree.
2. The skill commits the new plan file in the worktree.
3. The skill merges the worktree to main following AGENTS.md cleanup ordering.
4. After merge, the plan is available to any subsequent `/spec plan <id>` invocation (in a new worktree).

### Current state

There is no `/plan` skill, no `plan_write` MCP tool, and no command path that asks follow-ups until a plan meets the required artifact contract before writing it.

### Desired state

Any agent can follow the `/plan` skill, take a request like `add gemini cli integration`, infer a feature slug and title, ask focused clarifying questions only where needed, allocate the next `plan_id` via `nextPlanId()`, and call `plan_write` to save a valid `plans/<plan_id>-<slug>.md` artifact in the worktree only once the required sections and ordered implementation steps are unambiguous. The skill then commits and merges to main.

### Start here

- `plans/TEMPLATE.md` — authoritative artifact shape from Task 176
- `lib/planDocs.ts` — `nextPlanId()`, validator, parser from Task 176
- `mcp/handlers.ts` — existing MCP tool registry; add `plan_write` here
- `mcp/server.ts` — tool transport wiring
- `skills/create-task/SKILL.md`, `skills/spec/SKILL.md` — skill file shape and tone

**Affected files:**
- `lib/planAuthoring.ts` — plan-write orchestration and slug/title derivation helpers
- `lib/planAuthoring.test.ts` — derivation, validation, and write-gating tests
- `mcp/handlers.ts` — add `plan_write` handler
- `mcp/handlers.test.ts` — handler coverage
- `mcp/server.ts` — register the new tool
- `skills/plan/SKILL.md` — interactive workflow (invokable by any agent)
- `AGENTS.md` — lifecycle-verbs section referencing `/plan`
- `skills/orc-commands/SKILL.md` — document `plan_write` MCP tool and `/plan` skill
- `docs/cli.md` — user-visible `/plan` documentation

---

## Goals

1. Must auto-assign the next `plan_id` via Task 176's `nextPlanId()` allocator (concurrency-safe).
2. Must auto-derive a stable kebab-case `name` feature slug unless true ambiguity requires a follow-up.
3. Must not write a plan artifact until all required sections are concrete and no unresolved placeholders remain (must pass Task 176's validator).
4. Must write `derived_task_refs: []` as the default on fresh plans.
5. `plan_write` MUST write **only inside the current worktree**. It MUST NOT touch main, `.orc-state/backlog.json`, or perform git operations. The skill handles commit and merge.
6. Must preserve the plan as a definitive machine-consumable artifact rather than a transcript or options log.
7. Must keep `/plan` and `/spec plan <id>` aligned on the same plan artifact contract.
8. The `/plan` skill is agent-agnostic. It MUST include the standard worktree instruction: *"Run this verb inside a fresh worktree per the worker worktree workflow in AGENTS.md. Commit, merge to main, and clean up in the order AGENTS.md specifies."*
9. Feature-slug collision rule: if the derived `name` matches an existing feature slug in `.orc-state/backlog.json`, accept it only when the new plan's intent belongs to the same feature. If it collides with an unrelated feature, the skill must prompt the invoker to disambiguate (new slug or cancel). Document this rule in both the skill and the `plan_write` tool description.
10. Must update AGENTS.md (lifecycle-verbs section), `skills/orc-commands/SKILL.md` (MCP tool + skill reference), and `docs/cli.md` (user-visible verb docs) in this task.

---

## Implementation

### Step 1 — Add plan-write orchestration

**File:** `lib/planAuthoring.ts`

Implement helpers for:
- normalizing a user request into a candidate `title` and kebab-case `name`
- allocating the next `plan_id` via `lib/planDocs.ts::nextPlanId`
- validating a complete plan input via `lib/planDocs.ts::parsePlan` (run the parser on the to-be-written content to guarantee round-trip validity)
- writing `plans/<plan_id>-<slug>.md` atomically (reuse `lib/atomicWrite.ts` helpers)

The exported MCP-facing function signature:

```ts
export async function writePlan(input: {
  name: string;
  title: string;
  objective: string;
  scope: string;
  outOfScope: string;
  constraints: string;
  affectedAreas: string;
  steps: Array<{ title: string; body: string; dependsOn?: number[] }>;
}): Promise<{ planId: number; path: string }>;
```

No follow-up question logic lives here — that belongs in the skill. `writePlan` is the deterministic final step and writes only within the current worktree.

### Step 2 — Expose the MCP tool

**File:** `mcp/handlers.ts`

Add a `plan_write` handler that delegates to `lib/planAuthoring.ts::writePlan`.

**File:** `mcp/server.ts`

Register the tool on the transport.

### Step 3 — Add the skill

**File:** `skills/plan/SKILL.md`

A short agent-agnostic skill that describes the authoring flow:
- Run inside a fresh worktree (reference AGENTS.md worker worktree workflow).
- Normalize the request into a candidate `name` and `title`.
- Check for feature-slug collision; disambiguate if needed.
- Ask the user/invoker focused follow-ups to eliminate ambiguity in `Objective`, `Scope`, `Out of Scope`, `Constraints`, `Affected Areas`, and `Implementation Steps`. Do not ask if the information is already supplied.
- When all sections are concrete, call `plan_write`. The MCP tool itself allocates `plan_id` and writes the file into the worktree.
- Commit the new plan file in the worktree.
- Merge to main following AGENTS.md cleanup ordering.

Explicitly frame the skill as producing an authoritative artifact — not a transcript.

### Step 4 — Document the new surface

- **`AGENTS.md`** — ensure the "Lifecycle verbs" section (added alongside `/spec` in Task 179, or add it here if this task lands first) describes `/plan` as an agent-agnostic MCP-backed workflow with the worktree + merge-to-main expectation.
- **`skills/orc-commands/SKILL.md`** — list the `plan_write` MCP tool and reference the `/plan` skill.
- **`docs/cli.md`** — user-visible description of the `/plan` verb.

### Step 5 — Cover derivation, write-gating, and collision handling

**File:** `lib/planAuthoring.test.ts`

Add tests for:
- auto-derived kebab-case `name` and `title` from a request string
- `writePlan` allocates `plan_id` via `nextPlanId`
- `writePlan` fails validation when required sections are empty or placeholder-laden
- `writePlan` round-trips: the written file parses back through `parsePlan` without errors
- `writePlan` writes `derived_task_refs: []` on fresh plans
- `writePlan` does NOT touch `.orc-state/backlog.json` or invoke git
- feature-slug collision: unrelated collision raises; matching-feature collision is accepted

**File:** `mcp/handlers.test.ts`

Add an MCP handler test for `plan_write`.

---

## Acceptance criteria

- [ ] `plan_write(input)` allocates `plan_id` via `nextPlanId()` and writes `plans/<plan_id>-<slug>.md` atomically, within the current worktree only.
- [ ] `plan_write` does not touch `.orc-state/backlog.json`, git, or any file outside the worktree.
- [ ] Written plans round-trip through `parsePlan` without validation errors.
- [ ] Fresh plans carry `derived_task_refs: []`.
- [ ] `name` and `title` are auto-derived from the request when unambiguous.
- [ ] No plan file is written until the input passes the Task 176 validator.
- [ ] Feature-slug collisions with unrelated features are surfaced to the invoker; same-feature re-use is accepted.
- [ ] `skills/plan/SKILL.md` is agent-agnostic, contains the worktree + merge-to-main instruction, and describes committing and merging after `plan_write` returns.
- [ ] MCP tool is registered in `mcp/handlers.ts` and `mcp/server.ts` with matching tests in `mcp/handlers.test.ts`.
- [ ] `AGENTS.md`, `skills/orc-commands/SKILL.md`, and `docs/cli.md` describe the `/plan` verb and `plan_write` tool.
- [ ] The written artifact is authoritative guidance, not a transcript or options log.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/planAuthoring.test.ts`:

```ts
it('derives a kebab-case name and title from the user request', () => { ... });
it('allocates plan_id via nextPlanId', () => { ... });
it('writes derived_task_refs: [] on fresh plans', () => { ... });
it('rejects plan input with placeholder sections', () => { ... });
it('round-trips through parsePlan', () => { ... });
it('does not touch .orc-state/backlog.json or invoke git', () => { ... });
it('rejects unrelated feature-slug collisions', () => { ... });
```

Add to `mcp/handlers.test.ts`:

```ts
it('plan_write MCP handler writes a valid plan artifact', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/planAuthoring.test.ts lib/planDocs.test.ts mcp/handlers.test.ts
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** A too-permissive `/plan` flow could persist ambiguous plans that later drift during `/spec plan <id>` conversion.
**Rollback:** git restore mcp/server.ts mcp/handlers.ts lib/planAuthoring.ts lib/planAuthoring.test.ts skills/plan/ AGENTS.md skills/orc-commands/SKILL.md docs/cli.md && npm test
