---
ref: orch/task-125-add-task-creation-ambiguity-gate
epic: orch
status: done
---

# Task 125 — Add Task-Creation Ambiguity Gate

Independent. Blocks Tasks 126-129 because they all build on the same prompt files and should preserve this question-asking policy.

## Scope

**In scope:**
- `.codex/skills/create-task/SKILL.md` — add a deterministic ambiguity gate before the skill asks clarifying questions
- `.claude/skills/create-task/SKILL.md` — add the same ambiguity gate while preserving provider-specific tool names
- `.claude/agents/task-writer.md` — align the subagent prompt with the same question-asking policy
- `docs/backlog/README.md` — document the rule that local context resolution comes before user questions for backlog drafting

**Out of scope:**
- Changing runtime backlog registration behavior or MCP tool schemas
- Adding new scripts or helper binaries
- Broad prompt rewrites unrelated to task-creation workflow

---

## Context

Both task-creation skills currently allow clarification when the objective is ambiguous, but neither prompt defines a strong gate for when questions are actually justified. That leaves too much discretion to the model and can produce avoidable back-and-forth on requests that could be resolved from local context.

The cheapest win is policy, not tooling: define a short decision sequence that tells the agent to resolve easy facts locally, ask only when ambiguity materially changes scope, dependencies, or acceptance criteria, and otherwise proceed with explicit assumptions. This reduces tokens spent on low-value user turns and keeps the task-creation flow fast for common requests.

**Affected files:**
- `.codex/skills/create-task/SKILL.md` — primary Codex task-creation workflow
- `.claude/skills/create-task/SKILL.md` — Claude task-creation workflow
- `.claude/agents/task-writer.md` — Claude subagent prompt used for backlog drafting
- `docs/backlog/README.md` — operator-facing backlog creation guidance

---

## Goals

1. Must define the same question-asking policy across Codex and Claude task-creation prompts.
2. Must instruct the agent to resolve cheap local facts before asking the user anything.
3. Must limit clarification to ambiguities that materially affect scope, dependencies, or acceptance criteria.
4. Must prefer one focused question over a multi-question questionnaire when clarification is required.
5. Must require the agent to proceed with explicit assumptions when the remaining uncertainty is low-risk.

---

## Implementation

### Step 1 — Add a deterministic ambiguity gate to both create-task skills

**File:** `.codex/skills/create-task/SKILL.md`

**File:** `.claude/skills/create-task/SKILL.md`

Replace the current generic clarification sentence:

```md
If the objective is ambiguous, ask one focused clarifying question before drafting.
```

with this rule block near the orientation step:

```md
Before asking the user anything:
1. Resolve what you can from local context first.
2. Identify only ambiguities that materially affect scope, dependencies, or acceptance criteria.
3. Ask one focused question only if one of those ambiguities remains unresolved.
4. Otherwise proceed and record the assumption in `Context`.
```

Preserve provider-specific instructions, but do not keep any broader "ask if ambiguous" wording that bypasses this gate.

### Step 2 — Align the Claude task-writer subagent prompt

**File:** `.claude/agents/task-writer.md`

Replace the current generic `Clarify` step:

```md
1. Clarify — if the request is ambiguous, ask one focused question before proceeding.
```

with a step that enforces the same four-step gate so the subagent does not ask avoidable questions before inspecting local files.

### Step 3 — Document the policy for maintainers

**File:** `docs/backlog/README.md`

Add a short note under "Creating new tasks" clarifying that agents should:
- use local backlog context first
- ask only narrow questions when scope-defining ambiguity remains
- default to writing the markdown spec without runtime registration unless requested

---

## Acceptance criteria

- [ ] `.codex/skills/create-task/SKILL.md` contains an explicit local-resolution-first ambiguity gate.
- [ ] `.claude/skills/create-task/SKILL.md` contains the same ambiguity gate, adapted only where tool names differ.
- [ ] `.claude/agents/task-writer.md` no longer uses an unconstrained "ask if ambiguous" rule.
- [ ] The shared rule explicitly limits clarifying questions to scope-, dependency-, or acceptance-criteria-changing ambiguities.
- [ ] The shared rule explicitly says to record low-risk assumptions in `Context`.
- [ ] The old unconstrained clarification sentence is removed from both create-task skills and the Claude task-writer prompt.
- [ ] No runtime code, schemas, or MCP tool definitions are changed.
- [ ] No changes to files outside the stated scope.

---

## Tests

No automated tests.

Manual verification:

- Read `.codex/skills/create-task/SKILL.md`, `.claude/skills/create-task/SKILL.md`, and `.claude/agents/task-writer.md` and confirm the same four-step ambiguity gate appears in each prompt.
- Confirm none of those three files still contain the old unconstrained "ask one focused clarifying question before drafting/proceeding" instruction.
- Read `docs/backlog/README.md` and confirm it documents the local-resolution-first policy for task creation.

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
git diff -- .codex/skills/create-task/SKILL.md .claude/skills/create-task/SKILL.md .claude/agents/task-writer.md docs/backlog/README.md
```

```bash
rg -n "Resolve what you can from local context first|scope, dependencies, or acceptance criteria|record the assumption in `Context`" \
  .codex/skills/create-task/SKILL.md \
  .claude/skills/create-task/SKILL.md \
  .claude/agents/task-writer.md
```

```bash
! rg -n "ask one focused clarifying question before drafting|ask one focused question before proceeding" \
  .codex/skills/create-task/SKILL.md \
  .claude/skills/create-task/SKILL.md \
  .claude/agents/task-writer.md
```
