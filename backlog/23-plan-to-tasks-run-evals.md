---
ref: general/23-plan-to-tasks-run-evals
feature: general
priority: normal
status: done
depends_on:
  - general/21-plan-to-tasks-skill-draft
  - general/22-plan-to-tasks-test-prompts
---

# Task 23 — Run Evals for the plan-to-tasks Skill

Depends on Tasks 21 and 22. Blocks Task 24.

## Scope

**In scope:**
- Running with-skill and without-skill eval runs for each prompt in `evals/evals.json`
- Drafting assertions for each eval while runs are in progress
- Grading outputs and aggregating into `benchmark.json`
- Launching the eval viewer for human review

**Out of scope:**
- Modifying `skills/plan-to-tasks/SKILL.md` — that is Task 24
- Description optimization — that is Task 25

---

## Context

### Current state

The skill draft and eval prompts exist but no eval runs have been executed.

### Desired state

All 3 eval prompts have been run through with-skill and without-skill subagents, graded, aggregated into `benchmark.json`, and the eval viewer has been launched for human review.

### Start here

Read `evals/evals.json` to understand the 3 prompts and their expected outputs. Then locate the skill-creator plugin path:

```bash
ls ~/.claude/plugins/cache/claude-plugins-official/skill-creator/
```

Use the actual directory name found — the path contains a content-hash component that changes when the plugin is updated. Do not hardcode the hash.

**Affected files:**
- `skills/plan-to-tasks-workspace/iteration-1/` — eval outputs, grading, benchmark
- `skills/plan-to-tasks/evals/evals.json` — `expectations` assertions added during this task

---

## Goals

1. Must spawn with-skill and without-skill subagents for all 3 prompts in the same turn.
2. Must draft `expectations` assertions for each eval while runs are in progress (not after). If `expectations` are already present in `evals.json`, treat them as the baseline — review and augment them as runs complete rather than overwriting.
3. Must grade each run and produce `grading.json` per eval directory with `text`, `passed`, and `evidence` fields.
4. Must run the aggregation script to produce `benchmark.json` and `benchmark.md`.
5. Must launch the eval viewer (or generate static HTML if no display is available).
6. Must not modify `SKILL.md` — review and iteration happen in Task 24.

---

## Implementation

### Step 1 — Set up workspace

```bash
mkdir -p skills/plan-to-tasks-workspace/iteration-1
```

### Step 2 — Locate skill-creator path

```bash
ls ~/.claude/plugins/cache/claude-plugins-official/skill-creator/
# Use the actual hash directory name found — do not hardcode
SKILL_CREATOR=~/.claude/plugins/cache/claude-plugins-official/skill-creator/<HASH>/skills/skill-creator
# ^^^ Replace <HASH> with the actual directory name from the ls output above
```

### Step 3 — Spawn all runs in the same turn

For each of the 3 evals, spawn two subagents simultaneously:
- **With-skill:** skill path `skills/plan-to-tasks/`, task = eval prompt, save outputs to `iteration-1/eval-<id>-<name>/with_skill/run-1/outputs/`
- **Without-skill:** same prompt, no skill, save to `iteration-1/eval-<id>-<name>/without_skill/run-1/outputs/`

### Step 4 — Draft assertions while runs are in progress

If `expectations` are not yet present in `evals/evals.json`, draft them now and add to the file.
If `expectations` are already present (added in a prior run), review them against the in-progress runs and augment or correct as needed — do not blindly overwrite.
Write `eval_metadata.json` per eval directory.
Key assertions:
- Preview table shown before any files written
- Correct number of tasks created
- Dependency lines match the plan's logical structure
- Each task spec follows the create-task section order

### Step 5 — Grade, aggregate, launch viewer

```bash
python3 -m scripts.aggregate_benchmark skills/plan-to-tasks-workspace/iteration-1 \
  --skill-name plan-to-tasks
```

Launch viewer (static HTML for headless environments):
```bash
python3 $SKILL_CREATOR/../../../eval-viewer/generate_review.py \
  skills/plan-to-tasks-workspace/iteration-1 \
  --skill-name "plan-to-tasks" \
  --benchmark skills/plan-to-tasks-workspace/iteration-1/benchmark.json \
  --static skills/plan-to-tasks-workspace/iteration-1/review.html
```

---

## Acceptance criteria

- [ ] With-skill and without-skill runs exist for all 3 evals.
- [ ] `grading.json` exists in each run directory with `text`, `passed`, and `evidence` fields.
- [ ] `benchmark.json` and `benchmark.md` exist in `iteration-1/`.
- [ ] Eval viewer is launched and URL or static file path reported to user.
- [ ] `evals/evals.json` has `expectations` assertions (drafted during this task or reviewed and confirmed if already present).
- [ ] No changes to `skills/plan-to-tasks/SKILL.md`.

---

## Tests

Not applicable — task output is eval data and a benchmark JSON file, not executable code.

---

## Verification

```bash
python3 -m json.tool skills/plan-to-tasks-workspace/iteration-1/benchmark.json
```
