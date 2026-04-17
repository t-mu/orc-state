---
name: spec
description: >
  Converts an approved plan into a complete set of registered backlog task specs
  in one shot — with dependency inference and a preview. Prefers a saved plan
  artifact under `plans/<plan_id>-*.md` (invoke as `/spec plan <id>`) and falls
  back to the most recent numbered plan printed in
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

**Worktree rule:** Run this verb inside a fresh worktree per the worker
worktree workflow in AGENTS.md. Commit, merge to main, and clean up in the
order AGENTS.md specifies. The MCP tools this skill calls (`spec_preview`,
`spec_publish`) write only to the current worktree and a transient staging
directory under `.orc-state/plan-staging/<plan_id>/`; they never mutate main,
`.orc-state/backlog.json`, or git. After merge, the coordinator's auto-sync
picks up the new specs on its next tick — this skill does NOT call
`orc backlog-sync-check` as part of the flow.

## Source Model

`/spec` accepts the plan from one of two sources. The **file-backed path is
preferred**; the conversational path is retained as a fallback for quick
ad-hoc turns where no saved plan artifact exists.

### A. Saved plan artifact (preferred)

Invocation: `/spec plan <id>` (or `/spec plan <id> <feature-override>`).

1. Parse `<id>` as a positive integer from `$ARGUMENTS`.
2. Resolve and parse the plan file via the plan-docs helpers in
   `lib/planDocs.ts`:
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

## Step 1 — Orient and Prepare the Plan

Both invocation forms end up feeding a saved plan file to the MCP tools. The
only difference is how that file comes into existence.

**Saved plan (`/spec plan <id>`):** the plan artifact is already on disk at
`plans/<id>-*.md`. Capture `<id>` from `$ARGUMENTS`. No further prep needed.

**Conversational (`/spec` with no plan id):**

1. Extract the most recent numbered plan printed in the conversation. If none
   is visible, ask the user to paste or restate it as numbered steps and stop.
2. Structure the extracted plan into the plan artifact shape: the six
   required sections (`Objective`, `Scope`, `Out of Scope`, `Constraints`,
   `Affected Areas`, `Implementation Steps`) plus steps with titles, bodies,
   and explicit `Depends on: N` cues. Apply the dependency, grouping, and
   `reviewLevel` guidance in Step 2 and Step 2.5 below.
3. Call `plan_write` (MCP) with `name`, `title`, the section bodies, and
   `steps[]`. The tool allocates a new `plan_id`, writes
   `plans/<plan_id>-<name>.md` inside the current worktree, and returns
   `{ planId, path }`. Capture `planId` — that becomes the `<id>` used for
   the rest of the flow. Set `acknowledge_feature_collision: true` only if
   the user explicitly disambiguates an existing feature-slug collision.
4. Resolve the feature override, if any. A `$ARGUMENTS`-provided feature
   overrides `plan.name` only when the user explicitly asks. Otherwise
   `plan.name` wins for every generated task.

The engine's `startTaskNumber` is computed inside `spec_publish` by scanning
the worktree's `backlog/` directory — you do not need to look it up yourself.

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

## Step 3 — Preview via `spec_preview`

Call the `spec_preview` MCP tool. Always pass the absolute path to the
current worktree so the tool targets the right `plans/` and `backlog/`
directories — the MCP server's own cwd is the main checkout, not the
worktree:

```
spec_preview({ plan_id: <id>, worktree_path: '<assigned_worktree>' })
```

This is a pure read — nothing is written. It returns the plan header and the
`ProposedTask[]` the engine would generate. Render the result as a
confirmation table using the full ref (`<feature>/<N>-<slug>`):

```
Plan: <title>
Feature: <plan.name>

  #    ref                                  title                           deps
  21   general/21-write-skill-draft         Write the skill draft           Independent
  22   general/22-write-test-prompts        Write 3 test prompts            Independent
  23   general/23-run-evals                 Run evals                       Depends on 21, 22
  24   general/24-review-and-iterate        Review outputs and iterate      Depends on 23

Proceed? (confirm or adjust)
```

Wait for confirmation before calling `spec_publish`. If the user asks for
adjustments (titles, deps, grouping), edit the saved plan file, then call
`spec_preview` again.

**If the user cancels** (says "no", "cancel", "stop", "never mind", or
similar): stop immediately. Do not call `spec_publish`. Report: "Cancelled —
no tasks were created."

## Step 4 — Publish via `spec_publish`

Once the user confirms, call (again with the worktree path):

```
spec_publish({ plan_id: <id>, confirm: true, worktree_path: '<assigned_worktree>' })
```

`confirm` MUST be the literal boolean `true`. Any other value (including the
string `"true"`) hard-fails.

What this call does, entirely inside the current worktree:

1. Re-resolves and re-validates the plan.
2. Hard-fails if `derived_task_refs` is already non-empty (regeneration is a
   separate future task — create a new plan instead).
3. Creates `.orc-state/plan-staging/<plan_id>/` — the `mkdir` is the
   concurrency lock. If a stale directory exists from an aborted publish,
   the call hard-fails with instructions to remove it manually; this is
   intentional and has no override flag.
4. Runs the engine, stages the spec files, moves them atomically into the
   worktree's `backlog/`, and writes `derived_task_refs` back into the plan
   file.
5. Removes the staging directory on full success.

The return value contains `createdRefs`, `createdFiles`, and `planPath`.

**Do not write backlog files by hand** and **do not call `create_task`** —
the tool owns spec file creation. The engine already handles feature
stamping, dependency inference, grouping, and `reviewLevel` derivation per
the rules in Steps 2 and 2.5.

## Step 5 — Commit, Merge, and Report

After `spec_publish` returns, land the result through the standard worktree
workflow:

1. `git add` the new backlog specs and the updated plan file listed in
   `createdFiles` / `planPath`.
2. `git commit -m "feat(<feature>): spec tasks from plan <id>"` in the
   worktree.
3. Merge the worktree to main using the AGENTS.md cleanup ordering (merge →
   branch delete → worktree remove). In PR mode, push and let the PR
   reviewer land the change.

Do NOT call `orc backlog-sync-check` — runtime state is the coordinator's
responsibility. The auto-sync tick picks up the new specs from main
automatically. Any agent or operator may run `orc backlog-sync-check` ad-hoc
to verify, but it is not part of this verb's flow.

Report:
- Source (saved plan `<id>` or conversational; for conversational, also the
  newly-allocated `plan_id` returned by `plan_write`).
- `createdRefs` and their file paths.
- Updated plan path.

If `spec_publish` throws, surface the exact error. Common failure modes:
- `confirm must be true` — the tool was called without `confirm: true`.
- `already has derived_task_refs` — regenerating is not supported.
- `staging directory already exists` — a prior publish left stale state; the
  message names the directory to remove.
- `publication failed: ... Visible refs in backlog: ...` — partial failure;
  some specs landed but `derived_task_refs` was NOT written. Do not retry
  blindly — inspect the worktree, roll back the visible refs manually, and
  remove the staging directory before re-running.
