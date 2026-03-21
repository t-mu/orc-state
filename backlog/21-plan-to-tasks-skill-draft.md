---
ref: general/21-plan-to-tasks-skill-draft
feature: general
priority: normal
status: done
---

# Task 21 — Write the plan-to-tasks Skill Draft

Independent.

## Scope

**In scope:**
- `skills/plan-to-tasks/SKILL.md` — initial skill draft that reads a plan from conversation context, infers dependencies, shows a preview, and delegates spec generation to the create-task skill

**Out of scope:**
- `skills/create-task/SKILL.md` — must not be modified
- Any backlog or orchestrator state changes beyond this file

---

## Context

### Current state

There is no skill for converting an agent-printed plan into backlog tasks. The current workflow requires two manual steps: the agent prints a numbered plan, the user approves it, then separately asks to create tasks from each step.

### Desired state

A `plan-to-tasks` skill exists at `skills/plan-to-tasks/SKILL.md` that collapses those two steps into one. The skill reads the plan from the current conversation, infers dependencies, shows a preview for confirmation, then delegates all spec generation to `create-task`.

### Start here

Read `skills/create-task/SKILL.md` to understand the quality standards and section order that plan-to-tasks must delegate to.

**Affected files:**
- `skills/plan-to-tasks/SKILL.md` — new skill file

---

## Goals

1. Must read the plan from the current conversation context, not from a file.
2. Must extract numbered steps with their titles and body content.
3. Must infer dependencies based on logical need, not sequential order.
4. Must show a preview table and wait for user confirmation before writing any files.
5. Must handle edge cases: no plan in context (ask user), single-step plan (trivially Independent).
6. Must delegate task spec generation to `skills/create-task/SKILL.md`.
7. Must run `orc backlog-sync-check` after all tasks are registered and report failures explicitly.

---

## Implementation

### Step 1 — Create `skills/plan-to-tasks/SKILL.md`

Write the skill file with these sections: read create-task SKILL.md (first action), extract plan from context, orient (next task number + feature), infer dependencies, show preview + confirm, delegate to create-task per step, sync-check and report.

---

## Acceptance criteria

- [ ] `skills/plan-to-tasks/SKILL.md` exists and loads without error.
- [ ] Skill description triggers on "create tasks from that plan", "ok create the tasks", and similar phrases but not on single-task creation requests.
- [ ] Skill instructs agent to read `skills/create-task/SKILL.md` as the first concrete action.
- [ ] Dependency inference section distinguishes logical dependency from sequential order with at least one example.
- [ ] Preview step is present and requires confirmation before writing.
- [ ] No-plan edge case is handled: skill asks user to paste the plan rather than proceeding blindly.
- [ ] Single-step plan edge case is handled: trivially Independent, preview shows one row.
- [ ] No changes to files outside the stated scope.

---

## Tests

Not applicable — task output is a markdown skill file, not executable code.

---

## Verification

```bash
# No automated tests — skill is a markdown instruction file
# Manual: verify the file exists and parses correctly
cat skills/plan-to-tasks/SKILL.md
```
