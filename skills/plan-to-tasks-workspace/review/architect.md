# Architect Review — plan-to-tasks skill and backlog tasks 21–25

Reviewer: Architect agent (claude-sonnet-4-6)
Date: 2026-03-21
Files reviewed:
- `skills/plan-to-tasks/SKILL.md`
- `skills/plan-to-tasks/evals/evals.json`
- `backlog/21-plan-to-tasks-skill-draft.md` through `backlog/25-plan-to-tasks-optimize-description.md`
- `skills/create-task/SKILL.md` (delegatee)
- `skills/orc-commands/SKILL.md`
- `backlog/TASK_TEMPLATE.md`
- `AGENTS.md`

---

## Findings

### 1. MINOR — Skill/create-task composition is clean; no duplication detected

plan-to-tasks delegates spec generation, registration, and quality gating entirely to create-task
(Step 4, "delegating to create-task"). It does not reproduce the section rules, quality gate table,
or output contract from create-task. The boundary is clearly stated: "This skill owns three things:
plan parsing, dependency inference, and batch orchestration." This is the correct design.

No conflicts were found between the two skills on registration mechanics: plan-to-tasks explicitly
defers to create-task's "Register in backlog.json" step for each file, including the MCP vs CLI
choice and the soft-fail/warning pattern.

**Status: No action required.**

---

### 2. MUST FIX — Task 22's dependency declaration is logically unnecessary and sets a bad precedent

`backlog/22-plan-to-tasks-test-prompts.md` declares `depends_on: general/21-plan-to-tasks-skill-draft`.

The dependency line in the body also states: "Depends on Task 21. Blocks Task 23."

Task 22 writes a standalone JSON file (`evals/evals.json`) containing prompts. It does not read,
import, or build on the content of `SKILL.md` — the skill draft produced by Task 21. A worker
could author the three test prompts (which are plain natural-language strings) without the skill
draft existing at all.

AGENTS.md and SKILL.md Step 2 are explicit: "Sequential order alone is not a dependency. Two steps
that work on independent concerns can be executed in any order — default to Independent unless there
is a real logical reason to serialize."

The current dependency serializes Task 22 behind Task 21 for no technical reason. If Task 21 is
delayed (e.g. requeued), Task 22 is blocked unnecessarily. This is the exact anti-pattern the
plan-to-tasks skill is designed to teach agents to avoid. Having it appear in the very backlog
tasks that define the skill undercuts the instruction.

**Fix:** Remove `depends_on` from Task 22's frontmatter and change the body dependency line to
"Independent. Blocks Task 23."

---

### 3. SHOULD FIX — Task 25 dependency question: should it also depend on Task 23?

`backlog/25-plan-to-tasks-optimize-description.md` declares:
```yaml
depends_on:
  - general/21-plan-to-tasks-skill-draft
  - general/24-plan-to-tasks-review-iterate
```

The body states "Depends on Tasks 21 and 24."

Task 24 itself depends on Task 23 (eval runs), so Task 23 is transitively covered. An explicit
direct dependency on Task 23 would be redundant and is therefore correctly omitted. The modelled
chain — 21 → 22 → 23 → 24 → 25 — is correctly captured through the transitive closure, so the
answer to the question "should Task 25 also depend on 23?" is: no, it does not need a direct edge.

However, Task 25 depends on Task 21 directly (in addition to 24). This direct edge to 21 is
also transitively covered by 24 (24 → 23 → 22 → 21). The direct 25→21 dep is therefore
redundant. While redundant deps do not cause logical errors, they add noise to the graph and
could mislead a coordinator that evaluates earliest-start time. The direct 21 edge should be
removed, leaving only `depends_on: [general/24-plan-to-tasks-review-iterate]`.

**Fix:** Remove `general/21-plan-to-tasks-skill-draft` from Task 25's `depends_on` frontmatter
and update the body line to "Depends on Task 24."

---

### 4. SHOULD FIX — create-task's `ref` slug convention is inconsistently documented in plan-to-tasks

create-task Step 0 specifies the `ref` format precisely:
```
ref: <feature>/<slug>
```
where `<slug>` is the kebab-case filename _without_ the numeric prefix but _including_ the numeric
prefix in the slug — e.g. `orch/task-102-task-md-frontmatter` for file
`102-task-md-frontmatter.md`.

The actual task files in this batch follow a different convention:
`general/21-plan-to-tasks-skill-draft` (numeric prefix in slug, no `task-` prefix).

plan-to-tasks Step 1 says to get `next_task_seq` and "Resolve the feature", but it does not
reference or restate create-task's slug-construction rule. Agents executing plan-to-tasks will
read create-task (as instructed), but if the create-task documentation and the actual file
convention differ, the agent will produce wrong ref slugs.

This is a documentation debt in create-task, surfaced here. plan-to-tasks should add a note
pointing agents explicitly to create-task Step 0 for slug construction and cross-check the
example in the batch against the template.

**Fix (in plan-to-tasks SKILL.md, Step 4):** Add one sentence: "Use create-task Step 0 for
slug construction — do not invent a convention."

---

### 5. SHOULD FIX — `--depends-on` CLI flag prohibition is correct but poorly explained

plan-to-tasks Step 4 says:
> Do not pass `--depends-on` to `task-create` CLI — it is rejected as a markdown-authoritative
> field. The frontmatter is the authoritative source.

This is correct per AGENTS.md write rules ("Do not send markdown-owned fields such as
`description`, `acceptance_criteria`, or `depends_on` through generic create/update
registration"). However, the instruction only covers the CLI path. An agent might try to pass
`depends_on` through `mcp__orchestrator__create_task` instead. The same prohibition applies
there — `depends_on` is markdown-authoritative for both CLI and MCP registration paths.

**Fix (in plan-to-tasks SKILL.md, Step 4):** Extend the prohibition to cover MCP:
"Do not pass `--depends-on` to `task-create` CLI or `depends_on` to `mcp__orchestrator__create_task`
— it is a markdown-authoritative field."

---

### 6. MINOR — Eval assertions were added in Task 23 but evals.json already contains them

Task 22's acceptance criteria (item 4) explicitly states: "No `assertions` field present — those
are added in Task 23." The `evals.json` produced by Task 22 (now committed) already contains a
populated `expectations` array for each eval. Task 23's implementation step 3 says to "Add
assertions to `evals/evals.json` and write `eval_metadata.json`" — but the file already has
them.

This is an execution-order anomaly: Task 22 was completed with assertions already present,
making the assertions step of Task 23 a no-op or a potential overwrite conflict. It does not
break anything, but the acceptance criteria for Task 22 were not met as written (item 4 was
violated). Task 23's execution will need to reconcile the existing assertions rather than add
from scratch.

**Status:** Low-impact; no spec change required, but the worker executing Task 23 should be
warned via a note in Task 23's context, or the acceptance criteria of Task 22 should be updated
to reflect reality. Mark as MINOR since both tasks are already `status: done`.

---

### 7. MINOR — Task 23 uses a hardcoded absolute plugin path that may not be portable

`backlog/23-plan-to-tasks-run-evals.md` Implementation and Context sections reference:
```
~/.claude/plugins/cache/claude-plugins-official/skill-creator/90accf6fd200/skills/skill-creator/SKILL.md
```

The path includes a content-hash directory component (`90accf6fd200`). If the skill-creator
plugin is updated, this path will silently break. Task 25 has the same issue in its Step 3
shell snippet.

**Fix:** Replace the hardcoded hash path with a glob or an env var reference, or at minimum
add a comment: "Path includes a version hash — confirm the correct path with `ls ~/.claude/plugins/cache/claude-plugins-official/skill-creator/`."

---

### 8. MINOR — No `## Tests` section in task specs 21–25 (skill-file tasks are test-free by nature, but the omission is undocumented)

Tasks 21, 23, 24, and 25 all omit the `## Tests` section. create-task's output contract
requires a `## Tests` section in the fixed section order. The omission is defensible for
tasks whose only output is a markdown file or eval run (not executable code), but none of
the tasks include an explicit note explaining the omission.

TASK_TEMPLATE.md and create-task's Output Contract do not document a waiver condition for
skill-only tasks. A worker following create-task strictly would flag missing Tests sections
as a quality gate failure.

**Fix:** Each task spec that omits `## Tests` should include a line under that heading:
"Not applicable — task output is a markdown skill file / eval data, not executable code."
This makes the omission deliberate rather than accidental.

---

### 9. MUST FIX — Task 22 was committed with `depends_on` in frontmatter but `status: done`; Task 23's `depends_on` references a ref (`general/22-plan-to-tasks-test-prompts`) whose canonical slug doesn't match the filename convention

Task 23 frontmatter:
```yaml
depends_on:
  - general/21-plan-to-tasks-skill-draft
  - general/22-plan-to-tasks-test-prompts
```

The file is `22-plan-to-tasks-test-prompts.md` and the ref in its frontmatter is
`general/22-plan-to-tasks-test-prompts`. This is internally consistent. However, create-task
Step 0 instructs agents to build the slug as `<feature>/task-<N>-<slug>` with a `task-` prefix
(example in create-task: `orch/task-102-task-md-frontmatter`). The actual refs used here omit
the `task-` prefix entirely (`general/21-plan-to-tasks-skill-draft` not
`general/task-21-plan-to-tasks-skill-draft`).

The `depends_on` refs and the actual frontmatter refs are consistent with each other across all
five tasks — they all use the no-`task-`-prefix convention. So the graph is internally coherent.
The discrepancy is with create-task's documented example, not with this batch. This is the same
issue raised in finding 4 but from the graph consistency angle.

If `orc backlog-sync-check` validates `depends_on` refs against registered task refs, and the
registered refs follow the no-`task-`-prefix convention (as they appear to), this is fine at
runtime. The risk is if a future worker uses create-task's example literally and produces
`task-`-prefixed refs that fail to resolve as dependencies.

**Fix:** Same as finding 4 — align create-task's example with actual convention, and add
explicit note in plan-to-tasks Step 4.

---

## Dependency Graph Summary

```
21 (Independent)
22 (Independent — currently wrongly serialised behind 21; see finding 2)
23 depends on 21, 22
24 depends on 23
25 depends on 24 (redundant direct dep on 21 should be removed; see finding 3)
```

Correct modelled graph after fixes:
```
21  22  (both Independent, parallel)
 \  /
  23
  |
  24
  |
  25
```

---

## Verdict

NEEDS CHANGES

Two MUST FIX items require action before this skill and its backlog are considered correct:
1. Task 22 has a spurious `depends_on` on Task 21 that violates the dependency philosophy the
   skill itself teaches (finding 2).
2. The `--depends-on` / MCP prohibition in plan-to-tasks Step 4 is incomplete — it omits the
   MCP path (finding 5 — promoted from SHOULD FIX because it is a registration correctness gap,
   not just a style issue).

The SHOULD FIX items (3, 4, 5) should be addressed before the skill ships to avoid propagating
the redundant-dep and slug-convention issues to every batch of tasks created through this skill.
