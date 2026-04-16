---
ref: lifecycle-verbs/176-add-plan-artifact-contract-and-lookup
feature: lifecycle-verbs
review_level: full
priority: normal
status: todo
---

# Task 176 — Add Plan Artifact Contract and Lookup

Independent.

## Scope

**In scope:**
- Introduce `plans/` as a first-class artifact directory with a documented on-disk contract for `plans/<plan_id>-<slug>.md`.
- Add parsing and validation utilities for the required plan frontmatter and required markdown sections.
- Add deterministic lookup by numeric `plan_id`, including duplicate-match and not-found failure modes.

**Out of scope:**
- Converting plans into backlog task specs.
- Interactive `/plan` authoring flow.
- Preview, confirmation, staging, or publication of generated backlog specs.

---

## Context

The approved lifecycle-verbs design makes saved plan artifacts the authoritative input to later `/spec task <id>` execution. Today the repo has no dedicated `plans/` contract, no parser for required sections, and no lookup path that resolves `plan_id` to a single file.

Without that contract, later work would either keep depending on conversational context or invent inconsistent ad hoc plan parsing. This task establishes the storage shape, validation rules, and file resolution guarantees that the rest of the lifecycle-verbs work will consume.

### Current state

There is no `plans/` directory in the runtime contract, no helper that validates `plan_id`, `name`, `title`, `created_at`, `updated_at`, and `derived_task_refs`, and no code that rejects unresolved placeholders or malformed dependency cues in saved plan files.

### Desired state

The repo has one authoritative plan artifact contract, a parser/validator that returns structured plan data or a clear validation error, and a canonical lookup path that resolves `plans/<plan_id>-*.md` only when exactly one file matches.

### Start here

- `lib/paths.ts` — add any new path constants needed for `plans/`
- `backlog/TASK_TEMPLATE.md` — current task-spec style baseline
- `skills/plan-to-tasks/SKILL.md` — existing assumptions about plan structure that will need a file-backed replacement later

**Affected files:**
- `lib/paths.ts` — define `PLANS_DOCS_DIR` or equivalent path helpers
- `lib/planDocs.ts` — new parser/validator and lookup helpers
- `lib/planDocs.test.ts` — validation and lookup coverage
- `plans/TEMPLATE.md` — concrete artifact template for future `/plan`

---

## Goals

1. Must define the required plan frontmatter fields: `plan_id`, `name`, `title`, `created_at`, `updated_at`, and `derived_task_refs`.
2. Must require the sections `Objective`, `Scope`, `Out of Scope`, `Constraints`, `Affected Areas`, and `Implementation Steps`.
3. Must parse `Implementation Steps` as an ordered list and preserve each step title/body pair.
4. Must reject unresolved placeholders such as `TBD`, `TODO`, `???`, or bracketed fill-ins.
5. Must accept explicit dependency cues only in the exact form `Depends on: N[, N...]`.
6. Must resolve plan files by numeric prefix only and fail clearly on zero or multiple matches.

---

## Implementation

### Step 1 — Introduce plan paths and template

**File:** `lib/paths.ts`

Add path helpers for the top-level `plans/` directory alongside existing backlog/state path constants.

**File:** `plans/TEMPLATE.md`

Create a minimal template that matches the approved artifact contract exactly. Do not include exploratory sections like options, open questions, or status.

### Step 2 — Add plan parsing and validation helpers

**File:** `lib/planDocs.ts`

Implement helpers to:
- locate `plans/<plan_id>-*.md`
- parse frontmatter
- verify the `name` feature slug shape
- extract required sections
- parse ordered implementation steps
- reject unresolved placeholders and malformed dependency lines

Prefer a narrow API such as:

```ts
type ParsedPlanStep = {
  number: number;
  title: string;
  body: string;
  dependsOn: number[];
};

type ParsedPlan = {
  path: string;
  planId: number;
  name: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  derivedTaskRefs: string[];
  objective: string;
  scope: string;
  outOfScope: string;
  constraints: string;
  affectedAreas: string;
  steps: ParsedPlanStep[];
};
```

### Step 3 — Cover lookup and validation failures

**File:** `lib/planDocs.test.ts`

Add targeted tests for:
- valid plan parse
- missing required frontmatter
- missing required sections
- malformed `Implementation Steps`
- placeholder rejection
- exact dependency cue parsing
- no matching `plan_id`
- duplicate `plan_id` matches

Keep tests file-backed using temporary directories so later `/spec task <id>` work can reuse the fixtures.

---

## Acceptance criteria

- [ ] `plans/TEMPLATE.md` exists and matches the approved required frontmatter and section set.
- [ ] Plan lookup resolves only `plans/<plan_id>-*.md` and requires exactly one match.
- [ ] Parsed plan output includes ordered steps with title, body, and explicit dependency metadata.
- [ ] Placeholder markers and malformed dependency cue lines are rejected with clear errors.
- [ ] Duplicate `plan_id` files fail as an explicit duplicate-plan error.
- [ ] No changes to task generation, worktree creation, or command routing land in this task.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/planDocs.test.ts`:

```ts
it('parses a valid plan artifact', () => { ... });
it('rejects unresolved placeholders', () => { ... });
it('rejects malformed explicit dependency cues', () => { ... });
it('fails when plan lookup finds no matches', () => { ... });
it('fails when plan lookup finds multiple matches', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/planDocs.test.ts
```

```bash
nvm use 24 && npm test
```
