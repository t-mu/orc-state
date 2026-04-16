---
ref: lifecycle-verbs/176-add-plan-artifact-contract-and-lookup
feature: lifecycle-verbs
review_level: full
priority: normal
status: done
---

# Task 176 — Add Plan Artifact Contract and Lookup

Independent.

## Scope

**In scope:**
- Introduce `plans/` as a first-class artifact directory with a documented on-disk contract for `plans/<plan_id>-<slug>.md`.
- Add parsing and validation utilities for the required plan frontmatter and required markdown sections.
- Add deterministic lookup by numeric `plan_id`, including duplicate-match and not-found failure modes.
- Add an atomic `nextPlanId()` allocator so later authoring flows can assign ids without races.

**Out of scope:**
- Converting plans into backlog task specs.
- Interactive `/plan` authoring flow.
- Preview, confirmation, staging, or publication of generated backlog specs.

---

## Context

The approved lifecycle-verbs design makes saved plan artifacts the authoritative input to later `/spec plan <id>` execution. Today the repo has no dedicated `plans/` contract, no parser for required sections, and no lookup path that resolves `plan_id` to a single file.

Without that contract, later work would either keep depending on conversational context or invent inconsistent ad hoc plan parsing. This task establishes the storage shape, validation rules, file resolution guarantees, and id allocation primitive that the rest of the lifecycle-verbs work will consume.

### Current state

There is no `plans/` directory in the runtime contract, no helper that validates `plan_id`, `name`, `title`, `created_at`, `updated_at`, and `derived_task_refs`, and no code that rejects unresolved placeholders or malformed dependency cues in saved plan files.

### Desired state

The repo has one authoritative plan artifact contract, a parser/validator that returns structured plan data or a clear validation error, a canonical lookup path that resolves `plans/<plan_id>-*.md` only when exactly one file matches, and a `nextPlanId()` allocator that is safe against concurrent callers.

### Start here

- `lib/paths.ts` — add any new path constants needed for `plans/`
- `lib/taskSpecReader.ts` — reuse its existing heading/section parsing patterns; do not reinvent a markdown section parser
- `lib/atomicWrite.ts` — reuse atomic write primitives for the id allocator
- `backlog/TASK_TEMPLATE.md` — current task-spec style baseline
- `skills/plan-to-tasks/SKILL.md` — existing assumptions about plan structure that will need a file-backed replacement later

**Affected files:**
- `lib/paths.ts` — define `PLANS_DIR` or equivalent path helpers
- `lib/planDocs.ts` — new parser/validator, lookup, and `nextPlanId` helpers
- `lib/planDocs.test.ts` — validation, lookup, and id-allocation coverage
- `plans/TEMPLATE.md` — concrete artifact template for future `/plan`
- `AGENTS.md` — document `plans/` as a first-class artifact directory alongside `backlog/`
- `docs/concepts.md` and `docs/cli.md` — user-visible description of the `plans/` directory and the plan artifact contract

---

## Goals

1. Must define the required plan frontmatter fields: `plan_id`, `name`, `title`, `created_at`, `updated_at`, and `derived_task_refs`.
2. `derived_task_refs` is required in frontmatter but an empty array (`[]`) is a valid value; fresh plans written by `/plan` will start with `[]`.
3. Must require the sections `Objective`, `Scope`, `Out of Scope`, `Constraints`, `Affected Areas`, and `Implementation Steps`.
4. Must parse `Implementation Steps` as an ordered list and preserve each step title/body pair.
5. Must reject unresolved placeholders using an exact regex set:
   - `\bTBD\b`
   - `\bTODO\b`
   - `\?{3,}`
   - bracketed fill-ins `\[[^\]]*\]` **only outside fenced code blocks and outside markdown link syntax (`[text](url)`)**
6. Must accept explicit dependency cues only in the exact form `Depends on: N[, N...]`. This structured marker is **plans-only**; backlog specs continue to use the existing prose `Depends on Task N.` form unchanged.
7. Must resolve plan files by numeric prefix only and fail clearly on zero or multiple matches.
8. Must reject plan files that are not UTF-8 without BOM.
9. `plan_id` and backlog task `<N>` prefixes are **independent sequences** — they may collide numerically without consequence.
10. Must provide `nextPlanId()` that atomically allocates the next free id by scanning `plans/` and returning one greater than the current maximum, safe against concurrent callers.

---

## Implementation

### Step 1 — Introduce plan paths and template

**File:** `lib/paths.ts`

Add a `PLANS_DIR` constant (or equivalent helper) alongside existing backlog/state path constants.

**File:** `plans/TEMPLATE.md`

Create a minimal template that matches the approved artifact contract exactly. Include frontmatter with `derived_task_refs: []` as the default. Do not include exploratory sections like options, open questions, or status. Document the plans-only `Depends on: N[, N...]` cue syntax inline.

### Step 2 — Add plan parsing and validation helpers

**File:** `lib/planDocs.ts`

Implement helpers to:
- locate `plans/<plan_id>-*.md`
- parse frontmatter
- verify the `name` feature slug shape
- extract required sections (reuse the section-parsing style already used in `lib/taskSpecReader.ts`)
- parse ordered implementation steps
- reject unresolved placeholders (per the exact regex set in Goal 5)
- reject malformed dependency lines
- reject non-UTF-8 or BOM-prefixed files
- allocate the next plan id atomically

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

function parsePlan(path: string): ParsedPlan;
function findPlanById(planId: number): string;  // throws on zero or multiple matches
function nextPlanId(): Promise<number>;         // atomic allocator
```

### Step 3 — Cover lookup, validation, and allocation failures

**File:** `lib/planDocs.test.ts`

Add targeted tests for:
- valid plan parse (including `derived_task_refs: []`)
- missing required frontmatter
- missing required sections
- malformed `Implementation Steps`
- placeholder rejection — positive and negative cases for each regex, including bracketed text inside fenced code blocks and inside markdown link syntax (must NOT trigger rejection)
- exact `Depends on: N[, N...]` cue parsing
- no matching `plan_id`
- duplicate `plan_id` matches
- BOM-prefixed file rejection
- `nextPlanId()` returns max+1 on a populated directory
- `nextPlanId()` is safe against two concurrent callers (they never collide)

Keep tests file-backed using temporary directories so later `/spec plan <id>` work can reuse the fixtures.

---

## Acceptance criteria

- [ ] `plans/TEMPLATE.md` exists and matches the approved required frontmatter and section set, with `derived_task_refs: []` as the default.
- [ ] Plan lookup resolves only `plans/<plan_id>-*.md` and requires exactly one match.
- [ ] Parsed plan output includes ordered steps with title, body, and explicit dependency metadata.
- [ ] Placeholder markers are rejected using the exact regex set in Goal 5; bracketed text inside fenced code blocks and inside markdown link syntax is accepted.
- [ ] Malformed `Depends on:` cue lines are rejected with clear errors. The structured cue is plans-only.
- [ ] Duplicate `plan_id` files fail as an explicit duplicate-plan error.
- [ ] `derived_task_refs: []` is accepted as valid.
- [ ] BOM-prefixed or non-UTF-8 plan files are rejected.
- [ ] `nextPlanId()` returns max+1 and is concurrency-safe.
- [ ] `AGENTS.md` documents `plans/` as a first-class artifact directory with the contract reference.
- [ ] `docs/concepts.md` and `docs/cli.md` describe the `plans/` directory and plan artifact contract for users.
- [ ] No changes to task generation, worktree creation, or command routing land in this task.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/planDocs.test.ts`:

```ts
it('parses a valid plan artifact with derived_task_refs: []', () => { ... });
it('rejects unresolved placeholders', () => { ... });
it('accepts bracketed text inside fenced code and markdown links', () => { ... });
it('rejects malformed explicit dependency cues', () => { ... });
it('fails when plan lookup finds no matches', () => { ... });
it('fails when plan lookup finds multiple matches', () => { ... });
it('rejects BOM-prefixed plan files', () => { ... });
it('allocates the next plan id atomically under concurrent callers', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/planDocs.test.ts
```

```bash
nvm use 24 && npm test
```
