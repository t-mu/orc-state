# Critic Review — Round 3
**Files reviewed:** SKILL.md, evals/evals.json, backlog/21–25
**Reviewer role:** CRITIC
**Round:** 3

---

## Round 2 MUST FIX Items — Verification

### F1 — `expectations` field in evals.json contradicts Task 22 AC

**Claimed fix:** Task 22 AC now has a historical note; Task 23 now handles pre-populated expectations.

**Verification:**

Task 22 AC (lines 69): "No `expectations` field present at the time this task is executed — those are added by Task 23. (The current file has `expectations` because Task 23 is already done.)"

Task 22 Goal 5 (line 51): "Must not include an `expectations` field at the time Task 22 is executed — assertions are added during the eval run in Task 23. (Note: the committed `evals.json` shows `expectations` because Task 23 has since completed and added them.)"

Task 23 Goal 2 (line 58): "Must draft `expectations` assertions for each eval while runs are in progress (not after). If `expectations` are already present in `evals.json`, treat them as the baseline — review and augment them as runs complete rather than overwriting."

**Status: FIXED.** The contradiction is resolved. Both the Goal and AC in Task 22 now carry an explicit parenthetical explaining the historical state, and Task 23 instructs agents to treat pre-existing expectations as a baseline rather than being confused. The file state is consistent with the documentation.

---

### F2 — Eval 1 dependency inference expectation ambiguous (TDD argument)

**Claimed fix:** Step 2 in conversation_context changed to middleware registration (clearly consumes Step 1).

**Verification:**

Eval 1 conversation_context (line 7): "**Step 2 — Register the middleware in the Express app**\nImport `authenticate` from the middleware file created in Step 1 and apply it as global middleware in `src/app.ts` using `app.use(authenticate)`."

Eval 1 expectation index 5 (line 16): "Step 2 (middleware registration) depends on Step 1 (the middleware file) — it imports `authenticate` directly from Step 1's output file"

**Status: FIXED.** The plan step was changed from "write tests" to "register middleware" — an unambiguously hard dependency. Step 2 imports `authenticate` directly from Step 1's output file. No TDD ambiguity remains. The expectation text matches the plan context precisely.

---

## Round 2 SHOULD FIX Items — Verification

### F3 — Task 24 Verification missing targeted check

**Claimed fix:** A python3 frontmatter check was added.

**Verification:**

Task 24 Verification (lines 101–108):
```bash
python3 -c "
import re, pathlib
text = pathlib.Path('skills/plan-to-tasks/SKILL.md').read_text()
assert text.startswith('---'), 'Missing frontmatter'
print('Frontmatter OK')
"
nvm use 24 && npm test
```

**Status: FIXED.** A targeted Python frontmatter check is present and runs before the full suite. This is consistent with the pattern in tasks 21–23.

Minor observation (not a blocker): The script imports `re` but never uses it. This is a trivial unused import — does not affect correctness or executability.

---

### F4 — Skip list didn't clarify registration is NOT skipped

**Claimed fix:** A line was added.

**Verification:**

SKILL.md Step 4, "Which create-task steps to skip in batch mode" section (lines 131–135):
"All other create-task steps — including the 'Register in backlog.json' step — apply unchanged for each task."

**Status: FIXED.** The line explicitly names the registration step as not skipped.

---

### F5 — Task 22 Goal 5 contradicted current file state

**Claimed fix:** A historical note was added.

**Verification:** Confirmed in F1 verification above — both Goal 5 and the relevant AC item now carry the parenthetical historical note.

**Status: FIXED.**

---

### F7/F8 — `<hash>` placeholders had no substitution note

**Claimed fix:** `# Replace <HASH>` comments added.

**Verification:**

Task 23, Step 2 (lines 79–80):
```bash
SKILL_CREATOR=~/.claude/plugins/cache/claude-plugins-official/skill-creator/<HASH>/skills/skill-creator
# ^^^ Replace <HASH> with the actual directory name from the ls output above
```

Task 25, Step 2 (lines 86–87):
```bash
SKILL_CREATOR=~/.claude/plugins/cache/claude-plugins-official/skill-creator/<HASH>/skills/skill-creator
# ^^^ Replace <HASH> with the actual directory name from the ls output in "Start here"
```

Task 25, Step 3 (lines 110–111):
```bash
SKILL_CREATOR=~/.claude/plugins/cache/claude-plugins-official/skill-creator/<HASH>/skills/skill-creator
# ^^^ Replace <HASH> with the actual directory name from the ls output in "Start here"
```

**Status: FIXED.** All three occurrences now have an explicit inline comment directing substitution, consistently capitalized as `<HASH>`. The comments correctly reference "ls output above" (Task 23) or "ls output in 'Start here'" (Task 25).

---

### F9 — Coordinator note said "if blocked"

**Claimed fix:** Changed to "auto-claimed or auto-dispatched."

**Verification:**

SKILL.md Step 4, Coordinator note (lines 121–125):
"If tasks get auto-claimed or auto-dispatched, use `orc task-reset <ref>` after all tasks are registered to reset them to `todo`."

**Status: FIXED.** The wording now accurately reflects the states `task-reset` handles.

---

## New Findings — Round 3

### NEW-1 — MINOR: Task 24 Verification has unused `import re`

**File:** `backlog/24-plan-to-tasks-review-iterate.md`, line 102

The python3 inline script begins with `import re, pathlib` but only uses `pathlib`. The `re` module is never referenced in the script body. This does not cause a runtime failure (unused imports are legal Python), but it's misleading — a future agent or operator reading this may wonder what regex operation was intended, or may suspect the check is incomplete. No action strictly required, but the stray import reduces clarity.

**Severity: MINOR** — no behavioral impact.

---

### NEW-2 — MINOR: Task 23 Step 5 viewer command uses relative `$SKILL_CREATOR` path but `cd` was not called

**File:** `backlog/23-plan-to-tasks-run-evals.md`, lines 108–113

Step 5 shows:
```bash
python3 $SKILL_CREATOR/../../../eval-viewer/generate_review.py \
  skills/plan-to-tasks-workspace/iteration-1 \
```

`$SKILL_CREATOR` is set as an absolute path in Step 2, so the path itself is fine. However, the positional argument `skills/plan-to-tasks-workspace/iteration-1` is a relative path. If the agent runs this command from a working directory other than the repo root, the relative path will resolve incorrectly. The pattern in Task 25's Step 3 (`cd $SKILL_CREATOR/../../../..  # skill-creator root` before running `python3 -m scripts.run_loop`) shows awareness of this concern for that task but not for Task 23's viewer command. The inconsistency is low-risk since agents typically run from the repo root, but it's a latent error surface.

**Severity: MINOR** — no behavioral gap for agents following normal workflow; moot if agent is always rooted at repo.

---

### NEW-3 — MINOR: SKILL.md Step 4 dependency line format omits case where task has BOTH predecessors AND a successor

**File:** `skills/plan-to-tasks/SKILL.md`, lines 143–147

The dependency line writing rules list:
- Single predecessor: `Depends on Task <N>.`
- Multiple predecessors: `Depends on Tasks <N1>, <N2>, and <N3>.`
- Has a successor: append `Blocks Task <N+1>.`
- No dependencies: `Independent.`

There is no example for the combined case: a middle task that has both predecessors AND a successor (e.g. Task 23 which "Depends on Tasks 21 and 22. Blocks Task 24."). An agent reading this list might write "Depends on Tasks 21 and 22." and omit the "Blocks Task 24." clause, or may correctly combine them by inference. The existing backlog tasks serve as implicit examples (Task 22's body says "Independent. Blocks Task 23."; Task 23's body says "Depends on Tasks 21 and 22. Blocks Task 24."), but the SKILL.md rule itself does not make the combination explicit.

**Severity: MINOR** — the list items logically compose, and the example preview table in Step 3 shows the correct dep strings; no behavioral gap expected in practice.

---

### NEW-4 — OBSERVATION: SKILL.md `argument-hint` and `$ARGUMENTS` feature-override path is underspecified

**File:** `skills/plan-to-tasks/SKILL.md`, lines 15–22

The frontmatter says `argument-hint: "[optional: override feature name]"` and the body says "if `$ARGUMENTS` provided a feature name, use it." However, no guidance is given for what happens if `$ARGUMENTS` contains something that is *not* a valid feature name (e.g., the user types extra text, a typo, or a full sentence). The `create-task` skill handles this by checking existing features and asking if uncertain. The plan-to-tasks skill does not specify whether it validates the override against existing features or uses it verbatim. This could lead to a task being registered under a non-existent feature with no warning.

**Severity: MINOR** — the `create-task` skill's feature resolution flow (Step 0.5) would catch this on delegation, but the plan-to-tasks skill doesn't make this explicit.

---

## Summary Table

| ID | Severity | File | Description | Status |
|----|----------|------|-------------|--------|
| F1 (R2) | MUST FIX | evals.json + backlog/22 | `expectations` field contradiction with Task 22 AC | FIXED |
| F2 (R2) | MUST FIX | evals/evals.json | Eval 1 dep expectation ambiguous (TDD) | FIXED |
| F3 (R2) | SHOULD FIX | backlog/24 | Verification missing targeted check | FIXED |
| F4 (R2) | SHOULD FIX | SKILL.md | Skip list didn't clarify registration not skipped | FIXED |
| F5 (R2) | SHOULD FIX | backlog/22 | Goal 5 contradicted current file state | FIXED |
| F7 (R2) | MINOR | backlog/23 | `<hash>` placeholder lacked substitution note | FIXED |
| F8 (R2) | MINOR | backlog/25 | Two `<hash>` placeholders lacked substitution notes | FIXED |
| F9 (R2) | MINOR | SKILL.md | Coordinator note said "if blocked" | FIXED |
| NEW-1 | MINOR | backlog/24 | Unused `import re` in python3 verification snippet | NEW |
| NEW-2 | MINOR | backlog/23 | Step 5 viewer command uses relative path; CWD-sensitive | NEW |
| NEW-3 | MINOR | SKILL.md | Dependency line format omits combined predecessor+successor case | NEW |
| NEW-4 | MINOR | SKILL.md | $ARGUMENTS feature override not validated against existing features | NEW |

---

## Assessment

All R2 MUST FIX and SHOULD FIX items are resolved. All new findings are MINOR severity — no behavioral gaps, no false-negative eval risk, no ambiguity that would cause an agent to fail the task. The unused `import re` in Task 24 is cosmetically awkward but harmless. The remaining MINOR items are either edge-case documentation gaps or consistency nits that do not block correct execution.

**VERDICT: APPROVED**
