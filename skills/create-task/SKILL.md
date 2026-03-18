---
name: create-task
description: >
  Creates backlog task spec files in backlog/. Use when the user says anything like
  "create a task", "add to backlog", "write a task for", "plan this as a task", "draft a
  task spec", "create tasks to backlog", or asks to break work into numbered task files.
  Also handles batch planning (multiple dependent tasks from a single request).
argument-hint: "[task title or description]"
---

# Create Task

$ARGUMENTS

Use this skill when the user asks to create or refine backlog task `.md` files.
The output target is task-spec markdown only.

## Completion Gate — Do Not Skip

A task-creation turn is complete only when all three are true:

1. The `backlog/<N>-<slug>.md` file is saved.
2. The matching task ref is created or updated in orchestrator state.
3. `orc backlog-sync-check` passes after the write/sync work.

Never stop after writing markdown files. If backlog registration or sync validation fails,
the turn is incomplete and the final response must list each failed ref explicitly.

## Step 0 — Orient Before Drafting

Run these before writing anything:

1. **Determine the next task number:**
   Call `mcp__orchestrator__get_status` and read `next_task_seq` from the response.
   That integer is `<N>` — the next available task number.

   ```bash
   # shell fallback (filesystem-based) if MCP is unavailable:
   ls backlog/ | grep -oE '^[0-9]+' | sort -n | tail -1 | xargs -I{} expr {} + 1
   ```

2. **Read the files the task will touch.** If scope is unclear, read
   `backlog/TASK_TEMPLATE.md` and 1–2 recent task files as reference.

3. **Check `git status`** to see what is already in flight.

4. **Populate frontmatter fields** before writing the file:
   - `ref`: `<feature>/<slug>` where `<slug>` is the kebab-case filename without the numeric prefix
     and `.md` extension (e.g. for `102-task-md-frontmatter.md` -> `orch/task-102-task-md-frontmatter`
     - include the numeric prefix in the slug).
   - `feature`: the resolved feature ref (e.g. `orch`).

If the objective is ambiguous, ask one focused clarifying question before drafting.

## Step 0.5 — Resolve Feature

Before writing any file, determine the feature for this task:

1. **Infer from context.** If the user's request unambiguously names a feature
   (e.g. "create an orch task", "add this to the infra feature"), use that value directly.
   Skip steps 2-4.

2. **Read existing features.** Use `ReadMcpResourceTool` with URI
   `orchestrator://state/backlog` and extract the `ref` field from each entry
   in the `features` array.

3. **Ask the user.** Use `AskUserQuestion` with a message such as:

   ```text
   Which feature should this task belong to?
   1. orch
   2. general
   3. infra
   x. Add new feature
   ```

   Present only the refs, one per line, numbered from 1. Always append `x. Add new feature` as the last option.

4. **Handle "Add new".** If the user selects `x`, use a second `AskUserQuestion`:

   ```text
   Enter the new feature name (lowercase, hyphen-separated, e.g. "my-feature"):
   ```

   Use the entered value as the feature ref. The `create_task` MCP call will create the
   feature if it does not yet exist (Task 103 behavior - only works for "general" automatically;
   for any other new feature name the agent must note it may not exist and the MCP call may fail).

5. **Store the resolved feature** and use it for:
   - The `feature:` frontmatter field in every .md file written during this skill invocation
   - The `feature` argument to `mcp__orchestrator__create_task` (Task 105)

## Required Inputs Before Drafting

Collect or infer these fields before writing:

- Task title
- High-level objective
- Dependencies and ordering intent
- Affected files or subsystems
- Verification commands
- Risk/regression notes (if relevant)

If a field is unknown, make a minimal reasonable assumption and mark it in `Context`.

## Style Rules (LLM-Targeted)

- Write for an autonomous coding agent, not for human brainstorming.
- Use explicit, testable statements.
- Include exact file paths whenever known.
- Distinguish `In scope` vs `Out of scope` clearly.
- Prefer deterministic instructions over vague guidance.
- Avoid speculative future work and broad refactors.
- Include required gates (build/tests/verification commands) when applicable.

## Output Contract

Final response requirements for this skill:

- List every task-spec file written.
- List every task ref registered or updated in orchestrator state.
- Report the result of `orc backlog-sync-check`.
- If any registration or sync step fails, include a `Registration failures:` block with one line per ref and the error.

Every task file must follow this section order exactly:

1. `# Task <N> — <Imperative Title>`  ← em-dash, not hyphen
2. Dependency line (e.g. `Independent.` or `Depends on Task N-1. Blocks Task N+1.`)
3. `## Scope`
4. `## Context`
5. `## Goals`
6. `## Implementation`
7. `## Acceptance criteria`
8. `## Tests`
9. `## Verification`

Include `## Risk / Rollback` whenever the task mutates state files (`*.json`, `events.jsonl`),
changes a JSON schema, adds/removes npm scripts or bin commands, or has partial-write failure modes.
Omit it for pure code changes with no stateful side effects.

Use these optional sections only when they improve execution quality:

- `## Open questions` — only if uncertainty blocks safe implementation
- `## Risks` — only if non-trivial regressions are likely (for pure-code tasks without a Rollback)

## Section Rules

- **Scope**: two sub-lists only (`In scope` / `Out of scope`); name specific files, functions, or concerns in each bullet; be narrow.
- **Context**: free-form paragraphs explaining why and what breaks without it; show buggy/missing code when relevant; end with `**Affected files:**` block listing `` `path` — role ``.
- **Goals**: 3–7 "Must ..." statements, each independently verifiable.
- **Implementation**: ordered `### Step N — <title>` steps; each names `**File:** \`path\`` and shows code shape, diff, or before/after block; call out invariants to preserve.
- **Acceptance criteria**: binary checklist; at least one failure/edge-case item; always end with `- [ ] No changes to files outside the stated scope.`
- **Tests**: exact test descriptions and file paths; show `it(...)` call shape when helpful.
- **Verification**: `nvm use 24 && npm test` always; add `orc doctor` and `orc status` only when schemas, state files, or CLI commands are touched.
- **Risk / Rollback**: `**Risk:** <what can go wrong>` followed by `**Rollback:** git restore <path> && npm test`.

## Single-Task Workflow

1. Capture objective and boundaries.
2. Define concrete in-scope and out-of-scope bullets.
3. Add implementation steps with file-level specificity.
4. Add acceptance criteria as checkboxes with observable outcomes.
5. Add tests and verification commands.
6. Ensure the task can be executed independently by an LLM agent.

## Step: Register in backlog.json

After saving each .md file, perform MCP registration immediately:

### 1. Read the ref from frontmatter

The saved file begins with:
```yaml
---
ref: <feature>/<slug>
feature: <feature-ref>
---
```
Extract the `ref` value.

### 2. Check if already registered

Call `mcp__orchestrator__get_task` with `task_ref: <ref>`.

- If the result contains `{ "error": "not_found" }` -> **create path**
- Otherwise -> **update path**

### 3a. Create path

Call `mcp__orchestrator__create_task` with:
- `title`: the task title from the `# Task N — Title` heading
- `feature`: the `feature` frontmatter value
- `ref`: the slug portion only (everything after the first `/` in the frontmatter ref)
- `description`: the first non-empty paragraph of the `## Context` section
- `acceptance_criteria`: native JSON array extracted from the `## Acceptance criteria` checklist items (strip the `- [ ] ` prefix from each line)

### 3b. Update path

Call `mcp__orchestrator__update_task` with `task_ref: <ref>` and any fields that have changed: `title`, `description`, `acceptance_criteria`.

### 4. Handle failure (soft-fail)

If the MCP call throws or returns an error, **do not abort**. Instead emit:

```text
⚠️  Registration warning
Task spec saved:  backlog/<filename>.md
Backlog sync:     FAILED — <error message>
Ref:              <ref>

To register now, say: "register <ref>"
```

Continue to the next task in a batch without interruption.

### 5. Validate sync before finishing

Run:

```bash
orc backlog-sync-check
```

If it fails, do not treat the task-creation job as complete. Report the failing refs or files in the final response.

## Batch Workflow

When the user asks to break work into multiple tasks:

1. Determine the starting task number (from Step 0).
2. Break work into atomic units — each with an independent success condition.
3. Assign sequential IDs and declare cross-task dependencies explicitly.
4. Sequence foundational changes before integration and tests.
5. Emit one complete task file per task using the same fixed section order,
   then immediately run the "Register in backlog.json" step for that task
   before moving to the next one.
6. After all files in the batch are registered, run `orc backlog-sync-check`.
7. Avoid hidden coupling — declare cross-task assumptions in `Context`.

## Quality Gate (score before saving)

| Section | Pass condition |
|---------|----------------|
| Scope | Explicit in-scope outcome + at least one named out-of-scope exclusion |
| Context | Explains why; links at least one affected file with a path |
| Goals | 3–7 "Must" statements, each independently verifiable |
| Implementation | Each step names a file path; code shape or diff shown |
| Acceptance criteria | Binary checklist; failure/edge-case item present; ends with scope guard; maps to implementation and tests |
| Tests | Names exact test descriptions and file path |
| Verification | Full-suite command present; smoke checks included when schema/state/CLI touched |
| Risk / Rollback | Present when task mutates state files, schemas, or has partial-write modes |
| Independence | Task can be executed by an LLM agent without further clarification |
| Language | Concise and unambiguous; no speculative or vague wording |

A draft is ready to save only when all applicable sections pass.

**Save path:** `backlog/<N>-<kebab-slug>.md`

## Reference

See `references/task-template.md` for the fill-in-the-blanks template.
