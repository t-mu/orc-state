---
ref: general/158-skill-task-grouping
feature: general
priority: high
status: done
review_level: none
---

# Task 158 — Optimize Task Grouping in plan-to-tasks and create-task Skills

Independent.

## Scope

**In scope:**
- Add "Step 2.5 — Optimize Task Grouping" to `skills/plan-to-tasks/SKILL.md`
- Add scope-check note to `skills/create-task/SKILL.md`
- Add `review_level` field to `backlog/TASK_TEMPLATE.md` frontmatter

**Out of scope:**
- Code changes to the coordinator, schemas, or worker protocol (Task 159)
- Changes to agent definitions (Task 159)
- Changes to AGENTS.md or worker bootstrap templates (Task 160)

---

## Context

The current `plan-to-tasks` skill encourages atomic task splitting without
considering token cost. Each task incurs ~17K tokens of fixed overhead
(bootstrap + AGENTS.md + explore). Grouping related work into fewer tasks
saves 40-64% of total token burn by reducing the number of workers spawned.

The skill currently has no grouping step — it goes directly from dependency
inference (Step 2, line 75) to preview (Step 3, line 94). The `create-task`
skill has no guidance about when to suggest merging with an existing plan.

**Start here:** `skills/plan-to-tasks/SKILL.md`

**Affected files:**
- `skills/plan-to-tasks/SKILL.md` — add grouping step
- `skills/create-task/SKILL.md` — add scope-check note
- `backlog/TASK_TEMPLATE.md` — add `review_level` to frontmatter

---

## Goals

1. Must add a grouping optimization step to `plan-to-tasks` between dependency inference and preview.
2. Must define concrete grouping rules (same files → merge, trivial scope → merge, different files → keep separate, >500 lines → keep separate).
3. Must include `review_level` assignment guidance (none/light/full) per task.
4. Must add a redirect note to `create-task` for multi-task scenarios.
5. Must add `review_level` to the task template frontmatter.

---

## Implementation

### Step 1 — Add grouping step to plan-to-tasks

**File:** `skills/plan-to-tasks/SKILL.md`

Insert between Step 2 (line 92, after the sequential-but-independent example) and Step 3 (line 94):

```markdown
## Step 2.5 — Optimize Task Grouping

After inferring dependencies, optimize the task set for LLM execution cost.
Each task incurs ~17K tokens of fixed overhead (bootstrap, AGENTS.md, explore).
Fewer, well-scoped tasks save more than micro-optimizing per-task overhead.

**Merge** sequential tasks when:
- They touch the same files (no parallelism benefit from splitting)
- Combined scope is ≤500 lines of changes
- They form a logical unit ("would this be one PR?")

**Merge** trivial-scope tasks (config edits, doc tweaks, dependency bumps)
into a single housekeeping task with numbered subtasks in Implementation.

**Keep separate** when:
- Tasks touch different files and can run on parallel workers
- Different expertise is needed (implementation vs testing vs docs)
- Combined scope exceeds ~500 lines (context window risk)

**Assign `review_level`** per task in frontmatter:
- `none` — documentation, config, changelog, .gitignore changes
- `light` — standard implementation touching ≤3 files, no state mutations
- `full` — complex refactors, schema changes, state file mutations, multi-file architectural changes

Default to `full` if unsure.
```

### Step 2 — Add scope-check note to create-task

**File:** `skills/create-task/SKILL.md`

Add after the line "Use this skill when the user asks to create or refine a single backlog task `.md` file." (line 16):

```markdown
**Scope check:** Before writing, assess whether this task should be merged with
related planned work. If the user has a multi-task plan in progress, suggest
using `plan-to-tasks` instead — grouping related work into fewer tasks reduces
worker bootstrap overhead significantly.
```

### Step 3 — Add review_level to task template

**File:** `backlog/TASK_TEMPLATE.md`

Add `review_level` to the frontmatter block:

```yaml
---
ref: <feature>/<slug>
feature: <feature-ref>
review_level: full
---
```

---

## Acceptance criteria

- [ ] `plan-to-tasks` has a "Step 2.5 — Optimize Task Grouping" section between Step 2 and Step 3.
- [ ] Grouping rules cover: same-file merge, trivial merge, parallel split, size limit.
- [ ] `review_level` assignment guidance (none/light/full) is included with clear criteria.
- [ ] `create-task` has a scope-check note redirecting to `plan-to-tasks` for multi-task work.
- [ ] `TASK_TEMPLATE.md` frontmatter includes `review_level: full` as default.
- [ ] No code changes — only skill/template text files modified.
- [ ] No changes to files outside the stated scope.

---

## Tests

Not applicable — task output is skill instruction text, not executable code.

---

## Verification

```bash
# Verify the grouping step exists
grep -q "Step 2.5" skills/plan-to-tasks/SKILL.md && echo "OK"
# Verify review_level in template
grep -q "review_level" backlog/TASK_TEMPLATE.md && echo "OK"
```
