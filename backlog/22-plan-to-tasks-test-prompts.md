---
ref: general/22-plan-to-tasks-test-prompts
feature: general
priority: normal
status: done
---

# Task 22 — Write Test Prompts for the plan-to-tasks Skill

Independent. Blocks Task 23.

## Scope

**In scope:**
- `skills/plan-to-tasks/evals/evals.json` — 3 realistic test prompts for the skill eval harness

**Out of scope:**
- `skills/plan-to-tasks/SKILL.md` — must not be modified in this task
- Assertion grading or running evals — that is Task 23

---

## Context

### Current state

No eval prompts exist for the plan-to-tasks skill.

### Desired state

`skills/plan-to-tasks/evals/evals.json` contains 3 realistic test prompts covering the main usage patterns: minimal approval, explicit plan reference, and user-specified parallelism constraint.

### Start here

Review the skill-creator eval schema at:
`~/.claude/plugins/cache/claude-plugins-official/skill-creator/`
(check the version hash in that directory first — the hash in any hardcoded path may be outdated)
`skills/skill-creator/references/schemas.md`

**Affected files:**
- `skills/plan-to-tasks/evals/evals.json` — new file

---

## Goals

1. Must produce exactly 3 test prompts in the skill-creator `evals.json` format.
2. Must vary phrasing: one minimal trigger, one explicit reference to the printed plan, one with a user-specified parallelism constraint.
3. Must include an `expected_output` description for each prompt.
4. Must include a `conversation_context` field per eval providing a sample numbered plan — evals are unrunnable without a prior plan in context.
5. Must not include an `expectations` field at the time Task 22 is executed — assertions are added during the eval run in Task 23. (Note: the committed `evals.json` shows `expectations` because Task 23 has since completed and added them.)

---

## Implementation

### Step 1 — Write `evals/evals.json`

Include a `conversation_context` field with a realistic sample numbered plan for each eval. The prompts alone are ambiguous without a plan in context.

---

## Acceptance criteria

- [ ] `skills/plan-to-tasks/evals/evals.json` exists and is valid JSON.
- [ ] Contains exactly 3 eval entries with `id`, `prompt`, `expected_output`, `files`, and `conversation_context` fields.
- [ ] Each `conversation_context` contains a sample numbered plan the skill can parse.
- [ ] Prompts vary in phrasing and cover minimal trigger, explicit reference, and user constraint cases.
- [ ] No `expectations` field present at the time this task is executed — those are added by Task 23. (The current file has `expectations` because Task 23 is already done.)
- [ ] No changes to files outside the stated scope.

---

## Tests

Not applicable — task output is a JSON data file, not executable code.

---

## Verification

```bash
# Validate JSON
python3 -m json.tool skills/plan-to-tasks/evals/evals.json
```
