---
ref: lifecycle-verbs/180-implement-interactive-plan-authoring-workflow
feature: lifecycle-verbs
review_level: full
priority: normal
status: todo
depends_on:
  - lifecycle-verbs/176-add-plan-artifact-contract-and-lookup
  - lifecycle-verbs/178-add-master-worktree-lifecycle-for-lifecycle-verbs
  - lifecycle-verbs/179-implement-spec-task-from-saved-plans
---

# Task 180 — Implement Interactive /plan Authoring Workflow

Depends on Tasks 176, 178, and 179. Blocks Task 181.

## Scope

**In scope:**
- Add the interactive `/plan ...` lifecycle verb for the master.
- Reduce ambiguity through follow-up questions until a valid authoritative plan artifact can be written.
- Auto-derive `plan_id`, `name`, and `title`, then write `plans/<plan_id>-<slug>.md` inside the dedicated master worktree.

**Out of scope:**
- Regenerating backlog task specs automatically after a plan changes.
- Generic multi-verb workflow abstractions beyond `/plan`.
- Executing backlog tasks or delegating workers directly from the `/plan` flow.

---

## Context

Once `/spec task <id>` exists, the second phase is the authoring side: `/plan` should let the master explore a user request, ask only the high-value follow-ups needed to remove ambiguity, and persist a definitive planning artifact for later `/spec task <id>` conversion.

The saved plan is not a discussion log. It is an authoritative machine-consumable guide that later agents can use without re-reading the full conversation.

### Current state

There is no `/plan` verb, no plan-id sequencing for `plans/`, and no command path that asks follow-ups until a plan meets the required artifact contract before writing it.

### Desired state

The master can take a user request like `/plan add gemini cli integration`, infer a feature slug and title, ask focused clarifying questions only where needed, and save a valid `plans/<plan_id>-<slug>.md` artifact in an isolated master worktree only once the required sections and ordered implementation steps are unambiguous.

### Start here

- `plans/TEMPLATE.md` — authoritative artifact shape from Task 176
- `lib/masterWorktree.ts` — master worktree lifecycle from Task 178
- `templates/master-bootstrap-v1.txt` — master command guidance, including future `/plan` routing

**Affected files:**
- `mcp/server.ts` — add the narrow `/plan` flow surface if tool support is needed
- `lib/planAuthoring.ts` — ambiguity-reduction and plan-writing orchestration
- `lib/planAuthoring.test.ts` — coverage for plan derivation and write gating
- `templates/master-bootstrap-v1.txt` — teach the master how to handle `/plan ...`

---

## Goals

1. Must auto-assign the next `plan_id`.
2. Must auto-derive a stable kebab-case `name` feature slug unless true ambiguity requires a follow-up.
3. Must not write a plan artifact until all required sections are concrete and no unresolved placeholders remain.
4. Must write the plan artifact into an isolated master worktree rather than the main checkout.
5. Must preserve the plan as a definitive machine-consumable artifact rather than a transcript or options log.
6. Must keep `/plan` and `/spec task <id>` aligned on the same plan artifact contract.

---

## Implementation

### Step 1 — Add plan authoring orchestration

**File:** `lib/planAuthoring.ts`

Implement the `/plan` flow to:
- normalize the user request into a candidate `title` and `name`
- determine whether follow-up questions are needed
- collect the minimum missing information
- validate that all required sections can be rendered concretely
- write `plans/<plan_id>-<slug>.md` only when the artifact is valid

### Step 2 — Wire the master command path

**File:** `templates/master-bootstrap-v1.txt`

Add explicit routing guidance for `/plan ...` that matches the authoritative artifact contract and the worktree requirement.

**File:** `mcp/server.ts`

If a dedicated tool is required for reliable execution, add only the narrow surface needed for `/plan` authoring; do not introduce a generic lifecycle-verb workflow engine in this task.

### Step 3 — Cover derivation and write gating

**File:** `lib/planAuthoring.test.ts`

Add tests for:
- auto-derived `plan_id`, `name`, and `title`
- unresolved-placeholder blocking
- no-write behavior when required sections remain ambiguous
- successful write of a valid plan artifact

---

## Acceptance criteria

- [ ] `/plan ...` can derive `plan_id`, `name`, and `title` for a valid saved plan artifact.
- [ ] The workflow asks follow-ups only when required to eliminate ambiguity.
- [ ] No plan file is written until required sections and ordered implementation steps are concrete.
- [ ] Written plans use the `plans/<plan_id>-<slug>.md` contract from Task 176.
- [ ] The flow uses the dedicated master worktree lifecycle from Task 178.
- [ ] The artifact written is authoritative guidance, not a transcript or options log.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/planAuthoring.test.ts`:

```ts
it('derives a plan id, feature slug, and title from the user request', () => { ... });
it('does not write a plan artifact while required sections are still ambiguous', () => { ... });
it('rejects unresolved placeholders before persistence', () => { ... });
it('writes a valid plan artifact once ambiguity is removed', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/planAuthoring.test.ts lib/masterWorktree.test.ts lib/planDocs.test.ts
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** A too-permissive `/plan` flow could persist ambiguous plans that later drift during `/spec task <id>` conversion.
**Rollback:** git restore mcp/server.ts lib/planAuthoring.ts lib/planAuthoring.test.ts templates/master-bootstrap-v1.txt plans/TEMPLATE.md && npm test
