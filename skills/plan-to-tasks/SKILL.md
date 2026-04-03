---
name: plan-to-tasks
description: >
  Reads the step-by-step plan just printed in the current conversation and creates all
  backlog task specs from it in one shot — with dependency inference, a preview, and a
  sync-check gate. Use when the user approves or actions a numbered plan that was already
  printed above in the conversation, with phrases like "create tasks from that", "turn
  those steps into tasks", "ok create the tasks", "looks good, go ahead", "convert that
  plan into tasks", "make the tasks", "yeah those steps look fine", or any similar
  approval signal aimed at an existing printed multi-step plan. Trigger on approval
  phrases directed at a plan that is already in the conversation — not when the user asks
  to create a single task, provides an inline list without a prior plan, or asks you to
  generate or show a plan. The distinguishing signal is: a plan was already printed AND
  the user now wants all of its steps turned into task files.
argument-hint: "[optional: override feature name]"
---

# Plan to Tasks

<!-- $ARGUMENTS: replaced with the optional feature-override text typed after the skill name, if any -->
$ARGUMENTS
<!-- If $ARGUMENTS is blank, no feature override was given — resolve the feature via Step 1.2. -->

Use this skill to convert a numbered plan — printed earlier in this conversation — into
a complete set of registered backlog task specs.

This skill owns three things: **plan parsing**, **dependency inference**, and
**batch orchestration**. For generating each individual task spec, it delegates to the
`create-task` skill.

**Before anything else:** read `skills/create-task/SKILL.md` now using the Read tool
and keep it in context for all task-writing steps below. All of create-task's style rules,
section requirements, quality gate, and registration flow apply to every task produced here.

## Step 0 — Extract the Plan from Context

Read the plan that was most recently printed in this conversation. A valid plan is a
numbered or phased list where each item has an identifiable title (and usually a
description). It may look like:

```
**Step 1 — Do X**
Description of what this involves and why.

**Step 2 — Do Y**
Description, sometimes with sub-bullets or questions.
```

Or a simpler numbered list: `1. Do X`, `2. Do Y`, etc.

A single unlabelled bullet list, a prose paragraph, or a one-sentence description
does not count as a plan — ask the user to clarify or restate it as numbered steps.

**If no such plan is visible:** ask: "I don't see a numbered plan in our conversation.
Could you paste the steps you'd like converted to tasks?"

**If only one step is present:** that is a valid (single-task) plan. Skip dependency
inference (trivially Independent) and proceed to the preview with one row.

Extract from each step:
- Its **title**
- Its **body** (description, sub-points, any code or file references)
- Any explicit dependency signals ("requires step N", "after X is done", "can run in parallel")

## Step 1 — Orient

1. **Get the next task number** via `mcp__orchestrator__get_status` → `next_task_seq`.
   Shell fallback (only if MCP is unavailable):
   `ls backlog/ | grep -oE '^[0-9]+' | sort -n | tail -1 | xargs -I{} expr {} + 1`

2. **Resolve the feature** — if `$ARGUMENTS` provided a feature name, use it.
   Otherwise, use the same process as create-task Step 0.5: infer from context,
   or ask the user with a numbered list of existing features.

## Step 2 — Infer Dependencies

For each step, decide whether it depends on any prior step. A dependency exists when:

- The step **consumes an output** produced by a prior step (e.g. "run evals against the
  draft" needs the draft to exist first)
- The step **builds on something** a prior step creates or modifies
- The plan text **explicitly states** a dependency or parallel constraint

Sequential order alone is **not** a dependency. Two steps that work on independent
concerns can be executed in any order — default to Independent unless there is a real
logical reason to serialize.

**Example of sequential-but-independent steps:** A plan to set up CI/CD might list:
"1. Write CI yaml", "2. Write deploy yaml", "3. Set env vars in CI", "4. Test pipeline".
Steps 1, 2, and 3 all modify configuration in independent files — none consumes the
output of another. Only step 4 has a real dependency (it needs 1, 2, 3 to exist to test).
Default all of 1, 2, 3 to Independent; only 4 depends on them.

## Step 3 — Show Preview and Confirm

Before writing any files, show a confirmation table. Use the **full `ref` slug**
(`<feature>/<N>-<slug>`) in the slug column — see create-task Step 0 for slug construction.

```
Plan: <title or first step's context>
Feature: <feature-ref>

  #    ref                                  title                           deps
  21   general/21-write-skill-draft         Write the skill draft           Independent
  22   general/22-write-test-prompts        Write 3 test prompts            Independent
  23   general/23-run-evals                 Run evals                       Depends on 21, 22
  24   general/24-review-and-iterate        Review outputs and iterate      Depends on 23
  25   general/25-optimize-description      Optimize triggering desc        Depends on 24

Proceed? (confirm or adjust)
```

Wait for confirmation before writing anything. If the user adjusts numbering, titles, or
deps, update your plan accordingly.

**If the user cancels** (says "no", "cancel", "stop", "never mind", or similar): stop
immediately. Do not write any files. Report: "Cancelled — no tasks were created."

## Step 4 — Create Tasks (delegating to create-task)

**Coordinator note:** If the live coordinator is running, it may auto-claim and dispatch
a task as soon as it syncs the spec. To prevent a task from being dispatched before its
dependencies are synced, write all task files in sequence from first to last. If tasks
get auto-claimed or auto-dispatched prematurely, use `orc task-reset <ref>` to reset them.

For each step, in order, run the **create-task workflow** (from `skills/create-task/SKILL.md`).
Treat the step's title + body as the task description input.

**Which create-task steps to skip in batch mode:**
- **Step 0 (orient / next_task_seq):** already done above — do not re-fetch.
- **Step 0.5 (feature resolution):** already done above — do not re-ask.
- **create-task Output Contract** (the final per-task report): do not emit a separate report per task — the batch report in Step 5 covers all tasks.

All other create-task steps — including the "Verify Sync" step — apply unchanged for each task.

**What differs from a normal create-task invocation:**

1. **Slug construction:** use create-task Step 0's slug rule exactly — do not invent a convention.

2. **Dependency line:** use the dep inference from Step 2 (or any user override from Step 3).
   Write the appropriate dependency line in the body:
   - Single predecessor: `Depends on Task <N>.`
   - Multiple predecessors: `Depends on Tasks <N1>, <N2>, and <N3>.`
   - Has a successor: append `Blocks Task <N+1>.`
   - No dependencies: `Independent.`
   Set `depends_on` in the markdown frontmatter when there is a real dep (list multiple refs if needed).
   Do **not** pass `--depends-on` to `task-create` CLI or `depends_on` to
   `mcp__orchestrator__create_task` — it is a markdown-authoritative field. The frontmatter
   is the authoritative source.

3. **Batch mode:** write all task files in sequence. The coordinator auto-syncs them.
   Run `orc backlog-sync-check` after the batch to verify.

4. **`## Tests` section:** for tasks whose output is a markdown file, eval data, or
   documentation (not executable code), include the section with a single line:
   `Not applicable — task output is a markdown/data file, not executable code.`

5. **Quality gate:** run create-task's quality gate for each task spec before saving it.

## Step 5 — Sync Check and Final Report

After all tasks are written, run `orc backlog-sync-check --refs=<ref1>,<ref2>,...` scoped to the refs created in this batch.

Report:
- Number of tasks created
- File paths written
- Sync check result (✓ or ✗ per ref)

If sync-check fails, the coordinator may not have ticked yet. Wait a few seconds
and retry. If it still fails, report the failing refs.
Do not hide failures behind aggregate pass/fail messages.
