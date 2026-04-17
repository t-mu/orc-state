---
name: plan
description: >
  Interactive plan-authoring workflow. Turns a high-level request into a
  definitive plan artifact at `plans/<plan_id>-<slug>.md` — not a chat
  transcript. Use when the user says "plan X", "draft a plan for X",
  "sketch a plan to do X", or otherwise asks you to produce an approved
  design before backlog tasks exist. Any agent (master, worker, automation)
  may invoke this skill.
argument-hint: "[one-line request the plan should satisfy]"
---

# Plan

$ARGUMENTS

This skill produces **authoritative guidance**, not a discussion log. A plan
that later agents can pick up via `/spec plan <id>` must be concrete enough
that they do not need to re-read the original conversation. Treat the final
artifact as a hand-off, not as notes.

The verbs are agent-agnostic — the master is simply the user-facing entry
point. This skill uses the `plan_write` MCP tool, which any caller can
invoke.

## Worktree Rule

**Run this verb inside a fresh worktree per the worker worktree workflow in
AGENTS.md. Commit, merge to main, and clean up in the order AGENTS.md
specifies.**

`plan_write` writes the plan file **only inside the current worktree**. It
does not mutate `.orc-state/backlog.json`, does not touch main, and does not
perform any git operations. Publication to main happens via the standard
worktree workflow: commit the new plan file, then merge the worktree to main
following the AGENTS.md cleanup ordering (merge → branch delete → worktree
remove). After merge, the plan becomes available to any subsequent `/spec
plan <id>` invocation.

## Artifact Shape

A plan file at `plans/<plan_id>-<slug>.md` must carry:

- Frontmatter: `plan_id` (auto-allocated), `name` (kebab-case feature slug),
  `title`, `created_at`, `updated_at`, `derived_task_refs: []` (empty on
  fresh plans).
- Sections, in order: `## Objective`, `## Scope`, `## Out of Scope`,
  `## Constraints`, `## Affected Areas`, `## Implementation Steps`.
- Implementation steps as `### Step N — Title` sub-headings with ordered
  bodies. Use the exact structured cue `Depends on: N` (or
  `Depends on: N, M`) to declare dependencies between steps. This cue is
  plans-only; backlog specs continue to use the prose `Depends on Task N.`
  form.
- No unresolved placeholders. The plan validator (`parsePlan` in
  `lib/planDocs.ts`) rejects `TBD`, `TODO`, three or more `?` characters, and
  bare bracketed fill-ins (`[like this]`) outside fenced code blocks and
  outside markdown link syntax (`[text](url)`). The plan file must be UTF-8
  without a byte-order mark.

See `plans/TEMPLATE.md` for the baseline shape.

## Step 1 — Normalize the Request

Derive a candidate `name` (kebab-case feature slug) and `title` (human-
readable) from `$ARGUMENTS`. Pick a slug that will still make sense as the
feature ref on any tasks later generated from this plan.

If the request is too vague to produce a slug that means something (e.g. a
one-word "cleanup" with no scope), ask one focused clarifying question
before proceeding.

## Step 2 — Check Feature-Slug Collision

Call `mcp__orchestrator__get_status` or `list_tasks` and extract the feature
refs from the response. Do not read `.orc-state/backlog.json` directly; use
the MCP tools.

- **No collision:** proceed.
- **Collision, but this plan genuinely belongs to the same feature:** accept
  it. When you later call `plan_write`, pass
  `acknowledge_feature_collision: true`.
- **Collision with an unrelated feature:** prompt the invoker to
  disambiguate. Offer a new slug (kebab-case) or let them cancel. Do not
  silently write a new plan under someone else's feature slug.

The `plan_write` tool enforces this: it rejects a colliding name unless
`acknowledge_feature_collision: true` is set.

## Step 3 — Ask Only the High-Value Follow-Ups

Your goal is to leave no ambiguity in the required sections:

- `Objective` — one or two sentences stating the outcome.
- `Scope` — concrete bulleted outcomes this plan delivers.
- `Out of Scope` — explicit exclusions.
- `Constraints` — hard constraints (systems that must not change,
  invariants, performance/compatibility requirements).
- `Affected Areas` — files, modules, or subsystems touched.
- `Implementation Steps` — ordered atomic steps with explicit dependencies.

Ask a question only when the answer would change what the plan says in one
of these sections. Do not ask about information the invoker has already
supplied. Do not ask for preferences the plan does not record (e.g. coding
style). Keep the loop tight: one focused question at a time is fine, but
batch trivially-related questions when sensible.

If an area is still unclear after one pass and the invoker is happy with a
reasonable default, record the default concretely — do not leave a TBD, a
bracketed fill-in, or a "see conversation above" reference in the plan
body. The plan must stand alone.

## Step 4 — Call plan_write

Once every section is concrete and the steps are ordered with any explicit
dependencies captured, call the MCP tool:

```ts
mcp__orchestrator__plan_write({
  name: "<kebab-slug>",
  title: "<Human readable title>",
  objective: "<concrete prose>",
  scope: "<bulleted markdown>",
  out_of_scope: "<bulleted markdown>",
  constraints: "<prose or bullets>",
  affected_areas: "<bulleted markdown>",
  steps: [
    { title: "...", body: "..." },
    { title: "...", body: "...", depends_on: [1] },
  ],
  // acknowledge_feature_collision: true  // only when Step 2 confirmed same-feature reuse
});
```

The tool:

1. Validates every section (placeholders rejected, required sections
   present, required frontmatter fields present).
2. Allocates the next `plan_id` atomically via `nextPlanId()`.
3. Renders the artifact, parses it back through `parsePlan` to guarantee
   round-trip validity, then writes `plans/<plan_id>-<slug>.md` atomically.
4. Returns `{ planId, path }`.

If validation fails, fix the offending section in the input and call again.
Do not massage the rendered file by hand.

## Step 5 — Commit and Merge

After `plan_write` returns successfully:

1. `git add` the new plan file in the worktree.
2. `git commit -m "chore(plan): add plan <plan_id> — <title>"` in the
   worktree (or `feat`/`fix` as appropriate — use the repo's commit
   discipline; see AGENTS.md → Commit Discipline).
3. Merge to main from the main checkout, following AGENTS.md cleanup
   ordering (merge → branch delete → worktree remove). The plan becomes
   available to any subsequent `/spec plan <plan_id>` invocation.

This skill does not delegate tasks, run `/spec`, or dispatch workers — that
is `/spec`'s job (or a deliberate later step). The handoff is the plan
file itself.

## Output Contract

The final response should:

- Confirm the plan id, slug, and file path (e.g. `plans/7-add-gemini-cli-integration.md`).
- Confirm the commit and merge-to-main status.
- Note whether a feature-slug collision was acknowledged.

Do not dump the full plan body into the response — the artifact is the
source of truth.
