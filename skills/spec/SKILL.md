---
name: spec
description: >
  Converts an approved plan into a complete set of registered backlog task specs
  in one shot — with dependency inference, a preview, and a sync-check gate.
  Prefers a saved plan artifact under `plans/<plan_id>-*.md` (invoke as
  `/spec plan <id>`) and falls back to the most recent numbered plan printed in
  the current conversation (invoke as `/spec`). Use when a plan exists — either
  on disk or already printed above — and the user wants all of its steps turned
  into task files. Trigger phrases include "create tasks from that", "turn
  those steps into tasks", "ok create the tasks", "convert that plan into
  tasks", "make the tasks", or any similar approval signal aimed at an
  existing plan. Do not trigger when the user asks for a single task, provides
  an inline list without a prior plan, or asks you to generate or show a plan.
argument-hint: "[plan <id>] | [optional: override feature name]"
---

# Spec

<!-- $ARGUMENTS: may contain `plan <id>` to select a saved plan, or an optional
     feature-override string. If blank, use the conversational fallback. -->
$ARGUMENTS

Use this skill to convert an approved plan into a complete set of registered
backlog task specs. The skill owns three things: **plan sourcing**,
**dependency inference**, and **batch orchestration**. For generating each
individual task spec, it delegates to the `create-task` skill.

This skill is agent-agnostic — any agent (master, worker, or reviewer) may
invoke it. It does not assume it is running as the foreground master.

**Before anything else:** read `skills/create-task/SKILL.md` now using the Read
tool and keep it in context for all task-writing steps below. All of
create-task's style rules, section requirements, quality gate, and
registration flow apply to every task produced here.

## Source Model

`/spec` accepts the plan from one of two sources. The **file-backed path is
preferred**; the conversational path is retained as a fallback for quick
ad-hoc turns where no saved plan artifact exists.

### A. Saved plan artifact (preferred)

Invocation: `/spec plan <id>` (or `/spec plan <id> <feature-override>`).

1. Parse `<id>` as a positive integer from `$ARGUMENTS`.
2. Resolve and parse the plan file via the plan-docs helpers (Task 176):
   - locate the single file matching `plans/<id>-*.md`
   - validate frontmatter (`plan_id`, `name`, `title`, `created_at`,
     `updated_at`, `derived_task_refs`) and required sections
     (`Objective`, `Scope`, `Out of Scope`, `Constraints`, `Affected Areas`,
     `Implementation Steps`)
   - extract ordered steps with title, body, and explicit `Depends on: N[, N...]`
     dependency cues
3. The resolved `plan.name` becomes the `feature` stamped on every generated
   backlog task. A user-provided feature override in `$ARGUMENTS` replaces it
   only when the user explicitly asks.
4. Feed the parsed plan to the engine (see **Engine Contract** below).

If lookup fails (zero or multiple matches) or validation fails, stop with a
clear error message and do not proceed.

### B. Conversational plan (fallback)

Invocation: `/spec` (no args), or `/spec <feature-override>`.

A valid plan is a numbered or phased list printed earlier in the current
conversation where each item has an identifiable title (and usually a
description). Example:

```
**Step 1 — Do X**
Description of what this involves and why.

**Step 2 — Do Y**
Description, sometimes with sub-bullets or questions.
```

Or a simpler numbered list: `1. Do X`, `2. Do Y`, etc.

A single unlabelled bullet list, a prose paragraph, or a one-sentence
description does not count as a plan — ask the user to clarify or restate it
as numbered steps.

**If no such plan is visible:** ask: "I don't see a numbered plan in our
conversation. Could you paste the steps you'd like converted to tasks, or save
a plan artifact under `plans/` and invoke `/spec plan <id>`?"

**If only one step is present:** that is a valid single-task plan. Skip
dependency inference (trivially Independent) and proceed to the preview with
one row.

Extract from each step:
- Its **title**
- Its **body** (description, sub-points, any code or file references)
- Any explicit dependency signals ("requires step N", "after X is done", "can
  run in parallel")

Structure the extracted steps into the same shape the engine expects (see
**Engine Contract**) before feeding them in. The conversational path does not
create a file under `plans/`; it produces an in-memory plan input only.

## Engine Contract

The engine (`lib/planToBacklog.ts`) is a pure function. It accepts a parsed
plan and returns proposed backlog tasks. It does not read conversation
context, write backlog files, or touch runtime state — those are the
surrounding skill's responsibility.

Input shape:

```ts
type PlanStepInput = {
  number: number;
  title: string;
  body: string;
  dependsOn?: number[];           // explicit cues from the plan
  groupId?: string | number;      // merge hint: steps sharing an id
  reviewLevel?: 'none' | 'light' | 'full';
};

type PlanInput = {
  name: string;                    // becomes `feature` on every ProposedTask
  title: string;
  startTaskNumber: number;         // from get_status.next_task_seq
  steps: PlanStepInput[];
};
```

Output shape:

```ts
type ProposedTask = {
  title: string;
  slug: string;                    // "<N>-<kebab-title>"
  ref: string;                     // "<feature>/<slug>"
  description: string;
  dependsOn: string[];             // refs within this batch
  reviewLevel: 'none' | 'light' | 'full';
  stepNumbers: number[];
  feature: string;                 // == PlanInput.name
};
```

The engine preserves grouping from `groupId`, infers cross-task dependencies
from step-level `dependsOn`, drops intra-group deps, and stamps every output
with `feature: <plan.name>`. `reviewLevel` values match the repo-wide enum
consumed by `lib/backlogSync.ts`.

## Step 1 — Orient

1. **Get the next task number** via `mcp__orchestrator__get_status` →
   `next_task_seq`. This becomes `startTaskNumber` in the engine input.
   Shell fallback (only if MCP is unavailable):
   `ls backlog/ | grep -oE '^[0-9]+' | sort -n | tail -1 | xargs -I{} expr {} + 1`

2. **Resolve the feature:**
   - Saved plan path: use `plan.name` from the plan artifact. A
     `$ARGUMENTS`-provided feature override replaces it only when the user
     explicitly asks.
   - Conversational path: if `$ARGUMENTS` provides a feature name, use it.
     Otherwise infer from context or ask the user (same process as create-task
     Step 0.5).

## Step 2 — Infer Dependencies (conversational path only)

The saved-plan path already carries explicit `Depends on: N[, N...]` cues,
which the engine consumes directly. Skip this step in that case.

For the conversational fallback, decide whether each step depends on any
prior step. A dependency exists when:

- The step **consumes an output** produced by a prior step (e.g. "run evals
  against the draft" needs the draft to exist first).
- The step **builds on something** a prior step creates or modifies.
- The plan text **explicitly states** a dependency or parallel constraint.

Sequential order alone is **not** a dependency. Two steps that work on
independent concerns can be executed in any order — default to Independent
unless there is a real logical reason to serialize.

**Example of sequential-but-independent steps:** a plan to set up CI/CD might
list: "1. Write CI yaml", "2. Write deploy yaml", "3. Set env vars in CI", "4.
Test pipeline". Steps 1, 2, and 3 all modify configuration in independent
files — none consumes the output of another. Only step 4 has a real
dependency (it needs 1, 2, 3 to exist to test).

Translate dependency decisions into `dependsOn: number[]` entries on each
`PlanStepInput`.

## Step 2.5 — Optimize Task Grouping

After resolving dependencies, decide whether to merge any steps into a single
backlog task. Each task incurs ~17K tokens of fixed overhead (bootstrap,
AGENTS.md, explore). Fewer, well-scoped tasks save more than
micro-optimizing per-task overhead.

**Merge** (assign the same `groupId`) sequential steps when:
- They touch the same files (no parallelism benefit from splitting).
- Combined scope is ≤500 lines of changes.
- They form a logical unit ("would this be one PR?").

**Merge** trivial-scope steps (config edits, doc tweaks, dependency bumps)
into a single housekeeping task with numbered subtasks in Implementation.

**Keep separate** when:
- Tasks touch different files and can run on parallel workers.
- Different expertise is needed (implementation vs testing vs docs).
- Combined scope exceeds ~500 lines (context window risk).

**Assign `reviewLevel`** per step (or group) in the engine input:
- `none` — documentation, config, changelog, .gitignore changes.
- `light` — standard implementation touching ≤3 files, no state mutations.
- `full` — complex refactors, schema changes, state file mutations, multi-file
  architectural changes.

Default to `full` if unsure. The engine picks the highest level among a
group's members.

## Step 3 — Show Preview and Confirm

Run the engine on the assembled `PlanInput` and render the returned
`ProposedTask[]` as a confirmation table. Use the full `ref` slug
(`<feature>/<N>-<slug>`) in the slug column — see create-task Step 0 for slug
construction.

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

Wait for confirmation before writing anything. If the user adjusts numbering,
titles, or deps, adjust the `PlanInput` and re-run the engine.

**If the user cancels** (says "no", "cancel", "stop", "never mind", or
similar): stop immediately. Do not write any files. Report: "Cancelled — no
tasks were created."

## Step 4 — Create Tasks (delegating to create-task)

**Coordinator note:** If the live coordinator is running, it may auto-claim
and dispatch a task as soon as it syncs the spec. To prevent a task from
being dispatched before its dependencies are synced, write all task files in
sequence from first to last. If tasks get auto-claimed or auto-dispatched
prematurely, use `orc task-reset <ref>` to reset them.

For each `ProposedTask`, in order, run the **create-task workflow** (from
`skills/create-task/SKILL.md`). Treat the proposed task's `title` and
`description` as the task description input.

**Which create-task steps to skip in batch mode:**
- **Step 0 (orient / next_task_seq):** already done above — use the
  per-task `slug` the engine produced.
- **Step 0.5 (feature resolution):** already done above — use the engine's
  `feature` stamp (or the user-provided override) for every task.
- **create-task Output Contract** (the final per-task report): do not emit a
  separate report per task — the batch report in Step 5 covers all tasks.

All other create-task steps — including the "Verify Sync" step — apply
unchanged for each task.

**What differs from a normal create-task invocation:**

1. **Slug construction:** use the engine's `slug` verbatim.

2. **Dependency line:** use the engine's `dependsOn` (task refs within this
   batch) to author the body dependency line:
   - Single predecessor: `Depends on Task <N>.`
   - Multiple predecessors: `Depends on Tasks <N1>, <N2>, and <N3>.`
   - Has a successor: append `Blocks Task <N+1>.`
   - No dependencies: `Independent.`
   Set `depends_on` in the markdown frontmatter when there is a real dep
   (list multiple refs if needed). Do **not** pass `--depends-on` to
   `task-create` CLI or `depends_on` to `mcp__orchestrator__create_task` — it
   is a markdown-authoritative field. The frontmatter is the authoritative
   source.

3. **Batch mode:** write all task files in sequence. The coordinator
   auto-syncs them. Run `orc backlog-sync-check` after the batch to verify.

4. **`## Tests` section:** for tasks whose output is a markdown file, eval
   data, or documentation (not executable code), include the section with a
   single line:
   `Not applicable — task output is a markdown/data file, not executable code.`

5. **Quality gate:** run create-task's quality gate for each task spec before
   saving it.

## Step 5 — Sync Check and Final Report

After all tasks are written, run `orc backlog-sync-check
--refs=<ref1>,<ref2>,...` scoped to the refs created in this batch.

Report:
- Source (saved plan `<id>` or conversational).
- Number of tasks created.
- File paths written.
- Sync check result (✓ or ✗ per ref).

If sync-check fails, the coordinator may not have ticked yet. Wait a few
seconds and retry. If it still fails, report the failing refs. Do not hide
failures behind aggregate pass/fail messages.
