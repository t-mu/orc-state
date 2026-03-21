---
ref: general/24-plan-to-tasks-review-iterate
feature: general
priority: normal
status: done
depends_on:
  - general/23-plan-to-tasks-run-evals
---

# Task 24 — Review Eval Outputs and Iterate on plan-to-tasks

Depends on Task 23. Blocks Task 25.

## Scope

**In scope:**
- Reading user feedback from the eval viewer (`feedback.json`)
- Updating `skills/plan-to-tasks/SKILL.md` based on feedback
- Re-running evals into `iteration-2/` if changes were made
- Repeating until feedback is empty or the user signals satisfaction (max 5 iterations)

**Out of scope:**
- Triggering description optimization — that is Task 25
- Changing `skills/create-task/SKILL.md`

---

## Context

### Current state

Eval runs from Task 23 are complete and the human has reviewed outputs in the viewer.
`feedback.json` contains their per-eval comments.

### Desired state

`SKILL.md` has been improved based on feedback. All feedback fields are empty or the user
has explicitly confirmed they are satisfied. No more than 5 iteration rounds have been run.

### Start here

Read `feedback.json` from `skills/plan-to-tasks-workspace/iteration-1/feedback.json`.

**Affected files:**
- `skills/plan-to-tasks/SKILL.md` — updated per feedback
- `skills/plan-to-tasks-workspace/iteration-2/` — second eval run if iteration occurs

---

## Goals

1. Must read `feedback.json` from the eval viewer before making any changes.
2. Must generalise from feedback — not patch individual test cases, but improve the skill's overall instructions.
3. Must re-run evals into a new `iteration-N/` directory after each change.
4. Must launch the viewer with `--previous-workspace` pointing at the prior iteration.
5. Must stop after a maximum of 5 iteration rounds, even if feedback is not yet empty — surface remaining issues to the user at that point.

---

## Implementation

### Step 1 — Read feedback

```bash
cat skills/plan-to-tasks-workspace/iteration-1/feedback.json
```

### Step 2 — Apply improvements to SKILL.md

Update `skills/plan-to-tasks/SKILL.md`. Focus improvements on the sections where feedback identified failures. Generalise — don't add narrow rules for single test cases.

### Step 3 — Re-run evals into iteration-2

Repeat the eval-run steps from Task 23, writing into `iteration-2/`. Pass `--previous-workspace` to the viewer.

### Step 4 — Repeat until done (max 5 rounds)

Continue until the user confirms satisfaction or all feedback fields are empty. Stop at 5 rounds and surface remaining issues to the user.

---

## Acceptance criteria

- [ ] `feedback.json` was read before any changes to `SKILL.md`.
- [ ] At least one iteration of review was completed.
- [ ] `SKILL.md` changes address feedback categories (not individual test-case patches) — each change covers a class of failure, not a single prompt.
- [ ] All feedback fields are empty, OR user has explicitly confirmed satisfaction, OR 5 rounds have been completed and remaining issues have been reported.
- [ ] No changes to files outside the stated scope.

---

## Tests

Not applicable — task output is a revised markdown skill file, not executable code.

---

## Verification

```bash
# Confirm skill file is valid YAML frontmatter
python3 -c "
import re, pathlib
text = pathlib.Path('skills/plan-to-tasks/SKILL.md').read_text()
assert text.startswith('---'), 'Missing frontmatter'
print('Frontmatter OK')
"
nvm use 24 && npm test
```
