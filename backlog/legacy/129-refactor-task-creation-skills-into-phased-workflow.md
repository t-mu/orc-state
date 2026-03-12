---
ref: orch/task-129-refactor-task-creation-skills-into-phased-workflow
epic: orch
status: done
---

# Task 129 — Refactor Task-Creation Skills into Phased Workflow

Depends on Tasks 125, 126, 127, and 128. Consolidates the new index and test-gap artifacts into a lower-context drafting workflow while preserving the earlier ambiguity gate and optional runtime-sync policy.

## Scope

**In scope:**
- `.codex/skills/create-task/SKILL.md` — rewrite the workflow into explicit locate/inspect/draft phases
- `.claude/skills/create-task/SKILL.md` — same phased workflow adapted to Claude tooling
- `.claude/agents/task-writer.md` — align the subagent prompt with the same phases
- `docs/backlog/README.md` — document the phased workflow at a high level

**Out of scope:**
- Adding new runtime MCP tools beyond the artifacts introduced by Tasks 126 and 127
- Rewriting unrelated skills or prompts outside task creation
- Broad repo-wide prompt cleanup unrelated to backlog drafting

---

## Context

The main remaining source of waste in task creation is context sprawl. Without explicit phase boundaries, the agent can accumulate many task files, source files, test files, and instructions in one long reasoning pass before drafting anything. That increases token cost and makes scope decisions noisier.

Once Task 126 provides a compact backlog index and Task 127 provides a deterministic test-gap manifest, the skills can be rewritten around a three-phase flow:

1. Locate — read the cheapest artifacts first and form a shortlist
2. Inspect — open only the shortlisted files needed to define scope
3. Draft — write the task from compact notes and validate required sections

This task is prompt- and workflow-focused. It should not add more tooling than the minimum needed to teach the agents to stop between phases and avoid broad context loading.

**Affected files:**
- `.codex/skills/create-task/SKILL.md` — primary phased workflow
- `.claude/skills/create-task/SKILL.md` — primary phased workflow for Claude
- `.claude/agents/task-writer.md` — phased subagent prompt
- `docs/backlog/README.md` — maintainer-facing explanation of the process

---

## Goals

1. Must define explicit `Locate`, `Inspect`, and `Draft` phases in both create-task skills.
2. Must require the skills to read `docs/backlog/index.json` before opening many markdown task files.
3. Must require the skills to read `orchestrator/test-manifest.json` first for testing-related backlog prompts.
4. Must define stopping rules for each phase so the agent narrows context before reading more files.
5. Must keep the drafting phase focused on writing from compact notes rather than re-reading large raw context.

---

## Implementation

### Step 1 — Add explicit phase blocks to both create-task skills

**File:** `.codex/skills/create-task/SKILL.md`

**File:** `.claude/skills/create-task/SKILL.md`

Rewrite the workflow to use exactly these artifact references and phase headers:

```md
Phase 1 — Locate
- Read docs/backlog/index.json
- Read runtime backlog index if relevant
- For testing prompts, read orchestrator/test-manifest.json
- Shortlist only the files and existing tasks that appear relevant

Phase 2 — Inspect
- Open only shortlisted markdown tasks and code/test files
- Stop once scope, dependencies, tests, and out-of-scope boundaries are concrete

Phase 3 — Draft
- Write the task from compact notes
- Validate required sections before saving
```

### Step 2 — Add stopping rules and exploration limits

**File:** `.codex/skills/create-task/SKILL.md`

**File:** `.claude/skills/create-task/SKILL.md`

Add deterministic guidance such as:
- do not open more than 2 recent task specs unless overlap remains unresolved
- do not inspect source/test bodies before `docs/backlog/index.json` has been read and a shortlist has been written down
- for testing-related prompts, do not inspect raw `orchestrator/` source files before `orchestrator/test-manifest.json` has been read
- stop locating once the relevant subsystem, candidate files, and overlapping task refs have been identified
- stop inspecting once the agent can name exact `In scope`, `Out of scope`, `Affected files`, `Tests`, and `Verification` entries without more file reads
- if `docs/backlog/index.json` or `orchestrator/test-manifest.json` is missing, fall back to direct file inspection and record that fallback explicitly in `Context`

### Step 3 — Align the Claude subagent and maintainer docs

**File:** `.claude/agents/task-writer.md`

**File:** `docs/backlog/README.md`

Update both to explain the phased workflow at a high level and to reference the generated index and test manifest as first-pass aids.

---

## Acceptance criteria

- [ ] `.codex/skills/create-task/SKILL.md` defines explicit `Locate`, `Inspect`, and `Draft` phases.
- [ ] `.claude/skills/create-task/SKILL.md` defines the same phases with equivalent stopping rules.
- [ ] Both skills instruct the agent to consult `docs/backlog/index.json` before opening many task markdown files.
- [ ] Both skills instruct the agent to consult `orchestrator/test-manifest.json` first for testing-related prompts.
- [ ] Both skills include at least one explicit exploration limit or stopping rule for each phase.
- [ ] Both skills include an explicit fallback path for when `docs/backlog/index.json` or `orchestrator/test-manifest.json` is absent.
- [ ] The phase instructions name the exact artifact paths `docs/backlog/index.json` and `orchestrator/test-manifest.json`.
- [ ] `.claude/agents/task-writer.md` aligns with the same phased workflow.
- [ ] `docs/backlog/README.md` explains the phased workflow and references the generated artifacts as first-pass aids.
- [ ] No runtime code, MCP schemas, or unrelated skills are changed.
- [ ] No changes to files outside the stated scope.

---

## Tests

No automated tests.

Manual verification:

- Read `.codex/skills/create-task/SKILL.md`, `.claude/skills/create-task/SKILL.md`, and `.claude/agents/task-writer.md` and confirm the three phases and stopping rules are present.
- Confirm the prompts reference `docs/backlog/index.json` and `orchestrator/test-manifest.json` as first-pass artifacts using those exact paths.
- Confirm the prompts explicitly describe the fallback behavior when either artifact is missing.
- Read `docs/backlog/README.md` and confirm it describes the locate/inspect/draft workflow.

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
rg -n "Phase 1 — Locate|Phase 2 — Inspect|Phase 3 — Draft|index.json|test-manifest.json|stop once" \
  .codex/skills/create-task/SKILL.md \
  .claude/skills/create-task/SKILL.md \
  .claude/agents/task-writer.md \
  docs/backlog/README.md
```

```bash
rg -n "docs/backlog/index.json|orchestrator/test-manifest.json|fall back to direct file inspection" \
  .codex/skills/create-task/SKILL.md \
  .claude/skills/create-task/SKILL.md \
  .claude/agents/task-writer.md
```

```bash
git diff -- .codex/skills/create-task/SKILL.md .claude/skills/create-task/SKILL.md .claude/agents/task-writer.md docs/backlog/README.md
```
