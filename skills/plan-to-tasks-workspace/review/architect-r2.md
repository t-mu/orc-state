# Architect Review — plan-to-tasks — Round 2

**Reviewer role:** Design correctness, dependency graph validity, composition patterns, structural soundness.
**Files reviewed:**
- `skills/plan-to-tasks/SKILL.md`
- `skills/plan-to-tasks/evals/evals.json`
- `backlog/21-plan-to-tasks-skill-draft.md`
- `backlog/22-plan-to-tasks-test-prompts.md`
- `backlog/23-plan-to-tasks-run-evals.md`
- `backlog/24-plan-to-tasks-review-iterate.md`
- `backlog/25-plan-to-tasks-optimize-description.md`

**Context files:** `skills/create-task/SKILL.md`, `AGENTS.md`, `backlog/TASK_TEMPLATE.md`

---

## Previously Flagged Issues — Verification

### MUST FIX #1 — Task 22 spurious `depends_on` on Task 21
**Status: FIXED**

Task 22 frontmatter contains no `depends_on` field (lines 1–6 of `backlog/22-plan-to-tasks-test-prompts.md`). The body text reads "Independent. Blocks Task 23." — correctly declaring independence from Task 21 and a blocking relationship toward Task 23. The dependency graph is now accurate: 21 and 22 are both independent, and 23 depends on both.

### MUST FIX #2 — `--depends-on`/MCP prohibition incomplete (CLI-only)
**Status: FIXED**

`SKILL.md` lines 142–144 now read:

> Do **not** pass `--depends-on` to `task-create` CLI or `depends_on` to
> `mcp__orchestrator__create_task` — it is a markdown-authoritative field. The frontmatter
> is the authoritative source.

Both the CLI path and the MCP path are explicitly prohibited. The prohibition is clear and complete.

### SHOULD FIX #3 — Task 25 redundant direct dep on Task 21 (transitive via 24)
**Status: FIXED**

Task 25 frontmatter now contains only:
```yaml
depends_on:
  - general/24-plan-to-tasks-review-iterate
```
The spurious direct dep on Task 21 has been removed. The body text reads "Depends on Task 24." with no mention of Task 21.

### SHOULD FIX #4 — plan-to-tasks didn't reference create-task Step 0 for slug construction
**Status: FIXED**

`SKILL.md` line 97 explicitly states:
> Use the **full `ref` slug** (`<feature>/<N>-<slug>`) in the slug column — see create-task Step 0 for slug construction.

And `SKILL.md` line 137:
> **Slug construction:** use create-task Step 0's slug rule exactly — do not invent a convention.

Both the preview step and the per-task creation step now delegate slug construction to `create-task/SKILL.md` Step 0.

### SHOULD FIX #5 — `--depends-on` prohibition needed to cover MCP explicitly
**Status: FIXED** (same as MUST FIX #2 above — resolved together.)

---

## Dependency Graph Review

```
21 (Independent) ─────────────────────────────────────────────────────►─┐
                                                                          ▼
22 (Independent) ─────────────────────────────────────────────────────► 23 → 24 → 25
```

**Frontmatter alignment:**

| Task | Frontmatter `depends_on` | Body dependency line | Correct? |
|------|--------------------------|----------------------|----------|
| 21   | (absent)                 | "Independent."       | YES |
| 22   | (absent)                 | "Independent. Blocks Task 23." | YES |
| 23   | `[general/21-..., general/22-...]` | "Depends on Tasks 21 and 22. Blocks Task 24." | YES |
| 24   | `[general/23-...]`       | "Depends on Task 23. Blocks Task 25." | YES |
| 25   | `[general/24-...]`       | "Depends on Task 24." | YES |

The dependency graph is valid, internally consistent, and contains no transitive redundancies. No cycles exist.

---

## Skill Composition with create-task

The composition pattern is clean on all critical points:

1. **Delegation is explicit and front-loaded** (SKILL.md lines 31–33): the skill mandates reading `skills/create-task/SKILL.md` before any task-writing step, and states that all of create-task's style rules, section requirements, quality gate, and registration flow apply.

2. **Duplication avoided:** The skill does not restate create-task's section order, quality gate table, or registration steps inline. It delegates by reference.

3. **Batch-mode delta is clearly isolated** (SKILL.md lines 135–155): the five overrides in Step 4 are precisely scoped — they address only what genuinely differs (skip re-fetch, slug authority, dep line injection, Tests section for data files, quality gate application). Nothing in this list contradicts create-task's core contract.

4. **Slug construction deferred correctly** (lines 97, 137): the skill does not define its own slug algorithm — it explicitly references create-task Step 0.

5. **Markdown-authoritative fields respected** (lines 142–144): `depends_on` is written into frontmatter directly and must not be passed to the CLI or MCP registration call. This is consistent with AGENTS.md's guidance that markdown is authoritative.

---

## evals.json Structural Review

The file is valid JSON with three eval entries. Each contains: `id`, `prompt`, `conversation_context`, `expected_output`, `files`, `expectations`.

One observation: Task 22's acceptance criteria (line 69 of the task spec) states "No `expectations` field present — those are added in Task 23." However, `evals.json` as currently committed already contains `expectations` arrays in all three entries. This is not an architectural defect — Task 23 is now `status: done`, so the file reflects the post-Task-23 state. The constraint in Task 22's AC was a temporal in-progress rule, not a permanent invariant. The current state is correct.

The eval scenarios cover the three required patterns: minimal trigger (eval 1), explicit plan reference (eval 2), user-specified parallelism constraint (eval 3). Dependency inference expectations are well-specified and logically sound for each scenario.

---

## Remaining Issues

### MINOR — Task 24 Verification section calls `npm test` unnecessarily

Task 24 (`backlog/24-plan-to-tasks-review-iterate.md`, lines 100–102) has this verification block:

```bash
nvm use 24 && npm test
```

The task's output is an updated `SKILL.md` and eval iteration directories — no TypeScript, no schemas, no state files are touched. Running the full test suite against a markdown edit adds noise and could mislead a worker into thinking test failures indicate a problem with their work. Per create-task's rules (SKILL.md: "Verification: `nvm use 24 && npm test` always"), this is technically compliant but it produces no useful signal for this task category.

This is a style issue, not a structural defect. It does not affect dependency correctness or composition soundness.

### MINOR — Task 22 "No `expectations` field" constraint is now stale

Task 22's acceptance criteria line 69 states: "No `expectations` field present — those are added in Task 23." Since Task 23 is done and the file now has `expectations`, the constraint is stale. This creates a misleading AC that a future reviewer could flag as "failed". The task is `status: done` so it cannot be re-executed, but the text creates unnecessary confusion in the historical record.

Not actionable, noted for completeness.

---

## Summary

All five issues from Round 1 have been correctly resolved. The dependency graph is valid with no transitive redundancy. The skill composition with create-task is clean — delegation by reference, no duplication, all batch-mode deltas are minimal and clearly scoped. The markdown-authoritative field handling is correct in both the skill and all task specs. The two remaining observations are minor and do not affect architectural correctness.

**VERDICT: APPROVED**
