---
ref: general/25-plan-to-tasks-optimize-description
feature: general
priority: normal
status: done
depends_on:
  - general/24-plan-to-tasks-review-iterate
---

# Task 25 — Optimize the plan-to-tasks Triggering Description

Depends on Task 24.

## Scope

**In scope:**
- Generating 20 trigger eval queries (should-trigger and should-not-trigger)
- Running the skill-creator `run_loop.py` optimization script
- Updating the `description` field in `skills/plan-to-tasks/SKILL.md` with the best result

**Out of scope:**
- Changing the skill body — only the `description` frontmatter field changes
- Re-running content evals — that was Task 24

---

## Context

### Current state

The skill body is stable after Task 24 iteration. The `description` field has not been
systematically optimized for triggering accuracy.

### Desired state

The `description` field has been updated to the best result from a 5-iteration optimization
loop, with before/after score reported to the user.

### Start here

Locate the skill-creator plugin path before using it:

```bash
ls ~/.claude/plugins/cache/claude-plugins-official/skill-creator/
# Use the actual directory name found — the hash changes when the plugin is updated
```

**Affected files:**
- `skills/plan-to-tasks/SKILL.md` — `description` frontmatter field updated
- `skills/plan-to-tasks-workspace/trigger-evals/trigger-eval.json` — eval query set

---

## Goals

1. Must generate 20 trigger eval queries: 10 should-trigger, 10 should-not-trigger.
2. Should-not-trigger queries must be near-misses (adjacent intent, not obviously irrelevant).
3. Must present queries to the user for review before running the optimization loop.
4. Must run `scripts/run_loop.py` with `--max-iterations 5` against the confirmed eval set.
5. Must update `description` in `SKILL.md` with `best_description` from the script output.
6. Must report before/after description and final test score.

---

## Implementation

### Step 1 — Generate trigger eval queries

Create 20 queries following the skill-creator guidance. Good should-trigger examples:
- "ok looks good, create the tasks" (minimal approval after a plan)
- "turn those 4 steps into backlog tasks"
- "create tasks from that plan, steps 2 and 3 can run in parallel"

Good should-not-trigger near-misses:
- "create a single task for the refactor" (create-task, not plan-to-tasks)
- "show me the plan for X" (plan creation, not conversion)
- "what tasks are currently in the backlog?" (status query)

Save to `skills/plan-to-tasks-workspace/trigger-evals/trigger-eval.json`.

### Step 2 — Present for user review

Generate the eval review HTML using the skill-creator template:

```bash
SKILL_CREATOR=~/.claude/plugins/cache/claude-plugins-official/skill-creator/<HASH>/skills/skill-creator
# ^^^ Replace <HASH> with the actual directory name from the ls output in "Start here"
# Read the template, substitute placeholders, write to temp file, open it
python3 -c "
import json, pathlib
template = pathlib.Path('$SKILL_CREATOR/assets/eval_review.html').read_text()
evals = json.loads(pathlib.Path('skills/plan-to-tasks-workspace/trigger-evals/trigger-eval.json').read_text())
html = template.replace('__EVAL_DATA_PLACEHOLDER__', json.dumps(evals))
html = html.replace('__SKILL_NAME_PLACEHOLDER__', 'plan-to-tasks')
html = html.replace('__SKILL_DESCRIPTION_PLACEHOLDER__', 'see SKILL.md')
pathlib.Path('/tmp/eval_review_plan-to-tasks.html').write_text(html)
"
# macOS:
open /tmp/eval_review_plan-to-tasks.html
# Linux / headless: report path to user instead:
# echo "Review file written to /tmp/eval_review_plan-to-tasks.html — open in browser to review queries"
```

Wait for the user to confirm or adjust queries. Check `~/Downloads/` for a downloaded
`eval_set.json` after the user clicks "Export Eval Set".

### Step 3 — Run optimization loop

```bash
SKILL_CREATOR=~/.claude/plugins/cache/claude-plugins-official/skill-creator/<HASH>/skills/skill-creator
# ^^^ Replace <HASH> with the actual directory name from the ls output in "Start here"
cd $SKILL_CREATOR/../../../..  # skill-creator root
python3 -m scripts.run_loop \
  --eval-set /path/to/orc-state/skills/plan-to-tasks-workspace/trigger-evals/trigger-eval.json \
  --skill-path /path/to/orc-state/skills/plan-to-tasks/ \
  --model claude-sonnet-4-6 \
  --max-iterations 5 \
  --verbose
```

Note: `--model` should match the model powering the current session. Verify the model ID
before running — `claude-sonnet-4-6` is the current default but may change.

### Step 4 — Apply best description

Update the `description` field in `skills/plan-to-tasks/SKILL.md` with the `best_description`
value from the script output.

---

## Acceptance criteria

- [ ] 20 trigger eval queries generated, reviewed by user, and saved.
- [ ] `run_loop.py` completes without error.
- [ ] `description` in `SKILL.md` updated with the optimized value.
- [ ] Before/after description and test score reported to the user.
- [ ] No changes to the skill body — only the `description` frontmatter field.

---

## Tests

Not applicable — task output is an updated description field in a markdown file, not executable code.

---

## Verification

```bash
# Confirm only the description field changed
git diff skills/plan-to-tasks/SKILL.md
```
