---
ref: general/159-review-level-schema-protocol
feature: general
priority: high
status: done
review_level: full
---

# Task 159 — Add review_level to Task Schema and Worker Protocol

Independent.

## Scope

**In scope:**
- Add `review_level` field to `schemas/backlog.schema.json` and `types/backlog.ts`
- Create `agents/reviewer.md` lightweight combined reviewer
- Replace hardcoded 2-reviewer Phase 3 in `templates/worker-bootstrap-v2.txt` with `review_level` branching
- Verify/extend frontmatter parser in `lib/backlogSync.ts` and `lib/taskSpecReader.ts`

**Out of scope:**
- Heartbeat changes (Task 160)
- Skill text changes (Task 158)
- Changes to existing `agents/critic.md` or `agents/integrator.md`
- Coordinator dispatch logic changes (review_level does not affect dispatch)

---

## Context

Every task currently spawns 2 sub-agent reviewers (critic + integrator) regardless
of complexity. This costs ~5,800 tokens per task. For trivial tasks (docs, config),
this is disproportionate. For standard tasks, one combined reviewer suffices.

The worker bootstrap (lines 89-139 of `templates/worker-bootstrap-v2.txt`)
hardcodes the 2-reviewer flow. The change: workers read `review_level` from
the task spec frontmatter and branch accordingly.

**Single source of truth:** `review_level` lives in markdown frontmatter only.
Workers already read the full task spec in Phase 1 — they get `review_level`
from there. It does NOT go in the task envelope (no dual source of truth).

**Start here:** `schemas/backlog.schema.json` (line 85, after `acceptance_criteria`)

**Affected files:**
- `schemas/backlog.schema.json` — add `review_level` field to Task definition
- `types/backlog.ts` — add `review_level` to Task type
- `agents/reviewer.md` — new file, lightweight combined reviewer
- `templates/worker-bootstrap-v2.txt` — replace Phase 3 (lines 89-139) with branching
- `lib/backlogSync.ts` — verify frontmatter parser syncs `review_level`
- `lib/taskSpecReader.ts` — verify spec reader exposes `review_level`

---

## Goals

1. Must add `review_level` (none|light|full) to the backlog schema as an optional field.
2. Must create a lightweight combined reviewer agent definition (~40 lines, maxTurns: 10).
3. Must make worker Phase 3 branch on `review_level` from the task spec.
4. Must default to `full` when `review_level` is not specified.
5. Must not break existing task specs that lack `review_level`.
6. Must pass `orc doctor` after schema changes.

---

## Implementation

### Step 1 — Add to backlog schema

**File:** `schemas/backlog.schema.json`

Add after the `acceptance_criteria` field (line 90):

```json
"review_level": {
  "type": "string",
  "enum": ["none", "light", "full"],
  "description": "Review intensity. none=self-review only, light=1 combined reviewer, full=2 reviewers (critic+integrator). Default: full."
}
```

### Step 2 — Add to Task type

**File:** `types/backlog.ts`

Add to the Task interface:

```typescript
review_level?: 'none' | 'light' | 'full';
```

### Step 3 — Create lightweight reviewer agent

**File:** `agents/reviewer.md`

```markdown
---
name: reviewer
maxTurns: 10
models:
  claude: sonnet
  codex: gpt-5.4
  gemini: 2.5-pro
tools: [Read, Grep, Glob, Bash]
---

# Reviewer

Combined code reviewer for standard-complexity changes. Use when
review_level is "light" — one pass covering correctness, conventions,
and integration fit.

## Instructions

Review the diff and acceptance criteria provided in your prompt.

Check:
1. Does the implementation satisfy all acceptance criteria?
2. Are there regressions, bugs, or missed edge cases?
3. Does the code follow repo conventions (commit format, test patterns, file structure)?
4. Does it integrate cleanly with the surrounding system?

Do NOT explore the codebase independently — review the provided diff only.

Output format — wrap your entire response in this block:

REVIEW_FINDINGS
verdict: approved | findings

<one finding per issue, or "No issues found.">
REVIEW_FINDINGS_END
```

### Step 4 — Replace Phase 3 in worker bootstrap

**File:** `templates/worker-bootstrap-v2.txt`

Replace the hardcoded 2-reviewer block (lines 89-139) with:

```
  6. Sub-agent review round (depends on review_level from task spec frontmatter):

     review_level: none
       Self-review: read your own diff against the acceptance criteria.
       If all criteria are met, commit and proceed. No sub-agents spawned.

     review_level: light
       Spawn ONE reviewer (agents/reviewer.md) with:
       - The acceptance criteria
       - The full diff: git diff --stat --patch main...HEAD
       - The REVIEWER CONSTRAINTS block below
       Address all findings in a fixup commit. One round only.

     review_level: full (default if not specified in frontmatter)
       Spawn TWO independent reviewers (critic + integrator) with:
       - The acceptance criteria
       - The full diff: git diff --stat --patch main...HEAD
       - The REVIEWER CONSTRAINTS block below
       Address all findings in a fixup commit. One round only.

     --- REVIEWER CONSTRAINTS (pass verbatim to each reviewer) ---
     [keep existing REVIEWER CONSTRAINTS block unchanged, lines 98-124]
     --- END REVIEWER CONSTRAINTS ---

     Retrieve findings: {{orc_bin}} review-read --run-id=<run_id>
     [keep existing retrieval/retry logic, lines 125-138]
```

Preserve the existing REVIEWER CONSTRAINTS block and retrieval logic unchanged.
The only structural change is the branching preamble.

### Step 5 — Verify frontmatter parser

**File:** `lib/backlogSync.ts`, `lib/taskSpecReader.ts`

Read these files and verify the frontmatter parser handles `review_level`:
- If it uses a generic YAML parser that passes through unknown fields: no change needed.
- If it whitelists specific fields: add `review_level` to the whitelist.

---

## Acceptance criteria

- [ ] `schemas/backlog.schema.json` includes `review_level` with enum `["none", "light", "full"]`.
- [ ] `types/backlog.ts` Task type includes `review_level?: 'none' | 'light' | 'full'`.
- [ ] `agents/reviewer.md` exists with combined review instructions, maxTurns: 10.
- [ ] Worker bootstrap Phase 3 branches on `review_level` (none → self-review, light → 1 reviewer, full → 2 reviewers).
- [ ] Default behavior is `full` when `review_level` is absent from frontmatter.
- [ ] Existing task specs without `review_level` continue to work (backward compatible).
- [ ] Frontmatter parser syncs `review_level` to `backlog.json`.
- [ ] `orc doctor` exits 0 after schema change.
- [ ] `npm test` passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/backlogSync.test.ts` or `lib/taskSpecReader.test.ts`:

```typescript
it('syncs review_level from task spec frontmatter', () => { ... });
it('defaults review_level to undefined when absent', () => { ... });
```

Add to schema validation tests:

```typescript
it('accepts review_level values: none, light, full', () => { ... });
it('rejects invalid review_level values', () => { ... });
```

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
orc doctor
```

---

## Risk / Rollback

**Risk:** Schema change could invalidate existing backlog.json if field validation is strict. Since `review_level` is optional (not in `required`), existing state files remain valid.
**Rollback:** `git restore schemas/backlog.schema.json types/backlog.ts templates/worker-bootstrap-v2.txt && npm test`
