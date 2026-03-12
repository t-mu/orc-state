---
ref: orch/task-128-add-backlog-spec-runtime-sync-tool
epic: orch
status: done
---

# Task 128 — Add Backlog Spec Runtime Sync Tool

Depends on Tasks 124 and 127. Converts markdown task specs into optional runtime registration without forcing registration into the default drafting path, while preserving the earlier prompt-policy changes.

## Scope

**In scope:**
- `scripts/backlog-sync-runtime.mjs` — read a markdown task spec and create/update the matching runtime backlog entry
- `docs/backlog/README.md` — document the spec-first, runtime-sync-optional workflow
- `.codex/skills/create-task/SKILL.md` — describe runtime sync as an optional post-step only
- `.claude/skills/create-task/SKILL.md` — same optional post-step behavior
- `.claude/agents/task-writer.md` — remove any instruction that makes runtime registration mandatory during drafting

**Out of scope:**
- Replacing `docs/backlog/*.md` as the source of truth for task specs
- Changing the `create_task` or `update_task` MCP schema
- Auto-registering every new markdown task as part of the default workflow

---

## Context

The repo convention is already correct: write the markdown task spec first, then optionally register it in the runtime dispatch queue. The current optimization gap is not a missing create mechanism; it is the lack of a deterministic bridge between the markdown spec and runtime state.

Today that bridge is prompt work. The agent has to re-extract the title, epic, description, acceptance criteria, and ref from the markdown it just wrote, then decide whether to call create or update. A dedicated sync script can do that deterministically and make runtime registration optional, explicit, and cheap.

Task 124 already establishes a stronger runtime numbering story in `backlog.json`. This task should build on that rather than re-invent sequence logic in the sync tool.

**Affected files:**
- `scripts/backlog-sync-runtime.mjs` — markdown-to-runtime sync script
- `docs/backlog/README.md` — workflow documentation
- `.codex/skills/create-task/SKILL.md` — optional sync step guidance
- `.claude/skills/create-task/SKILL.md` — optional sync step guidance
- `.claude/agents/task-writer.md` — drafting-only behavior

---

## Goals

1. Must provide a deterministic way to create or update runtime backlog entries from a markdown task file.
2. Must extract `ref`, `epic`, title, description, and acceptance criteria from the markdown spec without requiring the model to re-parse them manually.
3. Must keep markdown drafting as the default workflow and runtime sync as an explicit optional follow-up step.
4. Must soft-fail cleanly when runtime sync cannot be completed, leaving the markdown task spec intact.
5. Must align Codex and Claude task-creation instructions around the same spec-first, sync-optional model.

---

## Implementation

### Step 1 — Build a markdown-to-runtime sync script

**File:** `scripts/backlog-sync-runtime.mjs`

Implement a script that:
- accepts a task markdown path
- parses frontmatter and key sections
- checks whether `ref` already exists in runtime backlog state
- calls the appropriate create/update path through existing CLI or shared logic
- supports `--dry-run`

Fields to extract deterministically:

```txt
ref                  -> frontmatter ref
epic                 -> frontmatter epic
title                -> # Task N — Title heading
description          -> first non-empty paragraph in ## Context
acceptance_criteria  -> checkbox items from ## Acceptance criteria
```

### Step 2 — Update prompts to make sync optional

**File:** `.codex/skills/create-task/SKILL.md`

**File:** `.claude/skills/create-task/SKILL.md`

**File:** `.claude/agents/task-writer.md`

Adjust instructions so the default path is:
1. draft markdown
2. save file
3. optionally sync runtime state if the user asked for registration

Do not require runtime sync during every task-drafting invocation.

### Step 3 — Document the two-phase workflow

**File:** `docs/backlog/README.md`

Document:
- markdown spec is authoritative
- runtime sync is optional
- how to run `node scripts/backlog-sync-runtime.mjs <task-file>`
- how `--dry-run` should be used before updating runtime state

---

## Acceptance criteria

- [ ] `scripts/backlog-sync-runtime.mjs` can parse a markdown task file and determine whether to create or update the matching runtime task.
- [ ] The script supports a `--dry-run` mode that reports the intended create/update action without mutating runtime state.
- [ ] The extracted runtime fields come from deterministic markdown sections, not ad hoc prompt rewriting.
- [ ] Both create-task skills describe runtime registration as optional rather than mandatory.
- [ ] `.claude/agents/task-writer.md` no longer requires runtime registration during spec drafting.
- [ ] `docs/backlog/README.md` documents markdown-first, runtime-sync-optional workflow.
- [ ] Runtime sync failures are reported separately and do not invalidate the saved markdown spec.
- [ ] No changes to MCP tool schemas or unrelated runtime behavior.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `scripts/backlog-sync-runtime.test.mjs`:

```js
it('extracts ref, epic, title, description, and acceptance_criteria from a markdown task file');
it('reports create in dry-run mode when runtime task does not exist');
it('reports update in dry-run mode when runtime task already exists');
```

Use fixture markdown task files and a temp runtime state directory to assert both create and update dry-run behavior. Do not leave this as manual-only verification.

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
node scripts/backlog-sync-runtime.mjs --dry-run docs/backlog/128-add-backlog-spec-runtime-sync-tool.md
```

```bash
rg -n "optional post-step|markdown spec is authoritative|runtime sync" .codex/skills/create-task/SKILL.md .claude/skills/create-task/SKILL.md .claude/agents/task-writer.md docs/backlog/README.md
```

```bash
git diff -- docs/backlog/README.md .codex/skills/create-task/SKILL.md .claude/skills/create-task/SKILL.md .claude/agents/task-writer.md scripts/backlog-sync-runtime.mjs
```

## Risk / Rollback

**Risk:** If the sync script mis-parses a markdown task, it could create an incorrect runtime entry. `--dry-run` and spec-first workflow reduce the blast radius because the markdown task remains authoritative.
**Rollback:** `git restore scripts/backlog-sync-runtime.mjs docs/backlog/README.md .codex/skills/create-task/SKILL.md .claude/skills/create-task/SKILL.md .claude/agents/task-writer.md && npm test`
