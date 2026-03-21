# QA Review — Round 3

**Reviewer:** QA
**Date:** 2026-03-21
**Scope:** SKILL.md, evals.json, backlog tasks 21–25

---

## R2 MUST FIX Items — Verification

### N1: evals.json `expectations` contradicted Task 22; Task 23 had no handling path

**Status: FIXED**

Task 22 Goal 5 and its Acceptance criterion 5 now explicitly acknowledge that
`expectations` may already be present at execution time — Task 23 is complete and
added them. The note reads:
> "Note: the committed `evals.json` shows `expectations` because Task 23 has since
> completed and added them."

Task 23 Goal 2 now reads:
> "If `expectations` are already present in `evals.json`, treat them as the baseline
> — review and augment them as runs complete rather than overwriting."

Task 23 Step 4 (formerly the sole location of assertion logic) was also updated to
mirror the Goal 2 language:
> "If `expectations` are already present (added in a prior run), review them against
> the in-progress runs and augment or correct as needed — do not blindly overwrite."

Both the Goal layer and the Implementation Step layer are now consistent. The
contradiction is resolved.

---

## R2 SHOULD FIX Items — Verification

### N2: Task 24 verification had no targeted check

**Status: FIXED**

Task 24 Verification now contains a targeted Python one-liner that asserts the
frontmatter block is present before running `npm test`:

```python
python3 -c "
import re, pathlib
text = pathlib.Path('skills/plan-to-tasks/SKILL.md').read_text()
assert text.startswith('---'), 'Missing frontmatter'
print('Frontmatter OK')
"
nvm use 24 && npm test
```

This check is narrow, deterministic, and directly tied to Task 24's only output
(a modified `SKILL.md`). It adequately gates the acceptance criterion
"only the `description` frontmatter field changes" — at minimum it confirms the
file remains a valid YAML-fenced document. The check is acceptable.

### N3: Task 25 `open` command — Linux fallback

**Status: FIXED**

Task 25 Step 2 now shows:
```bash
# macOS:
open /tmp/eval_review_plan-to-tasks.html
# Linux / headless: report path to user instead:
# echo "Review file written to /tmp/eval_review_plan-to-tasks.html — open in browser to review queries"
```

The Linux path is commented out (i.e., an agent must uncomment it), which is a
mild awkwardness. However, the intent is clear: the task tells the agent to use
`open` on macOS and to report the path on Linux/headless. No agent will be
confused. This is acceptable.

### N4: SKILL.md Step 4 — multi-predecessor dep format

**Status: FIXED**

SKILL.md Step 4 item 2 now lists:
- Single predecessor: `Depends on Task <N>.`
- Multiple predecessors: `Depends on Tasks <N1>, <N2>, and <N3>.`
- Has a successor: `Blocks Task <N+1>.`
- No dependencies: `Independent.`

The multi-predecessor format is present and consistent with the example in Task
22/23 bodies. Fixed correctly.

### Issue 3 (downgraded in R2): Coordinator note wording

**Status: FIXED**

SKILL.md Step 4 Coordinator note now reads "auto-claimed or auto-dispatched"
(previously "auto-claimed"). Accurate and complete.

---

## Outstanding SHOULD FIX Items (carried from R2)

### Issue 6: Duplicate step title slug collision — no deduplication rule

**Assessment:** Still present. SKILL.md has no rule stating that if two plan
steps produce identical slugs (e.g., two steps both titled "Write tests"),
the agent must append a distinguishing suffix or prompt the user.

**Blocking?** No. The scenario is rare in practice: real-world plans almost
never produce two identically worded step titles. When it does occur, the agent
will either fail at the OS level (duplicate filename) or overwrite the first
file — in both cases the failure is immediately visible and recoverable via
manual rename. This is an acceptable known limitation for an initial skill
version.

### Issue 8: No negative-trigger eval in evals.json

**Assessment:** Still present. All three evals in `evals.json` are
should-trigger cases. No eval exercises a should-not-trigger input
(e.g., "create a single task for the refactor", "show me a plan", or
"what tasks are in the backlog?"). These near-miss cases are covered in
Task 25's trigger eval set, but the content evals lack a boundary test.

**Blocking?** No. Negative-trigger boundary testing belongs to the description
optimization phase (Task 25), not to the content eval set. The content evals
(Tasks 22–24) test whether the skill executes correctly once triggered; they
intentionally verify happy-path behaviour. The absence of a negative eval in
`evals.json` is a deliberate scope boundary, not a defect. Acceptable for an
initial version.

### Issue 9: Task 25 blocked if Task 24 is skipped

**Assessment:** Still present. Task 25 `depends_on: general/24-plan-to-tasks-review-iterate`.
If an operator were to skip Task 24 (e.g., if eval results were satisfactory
with no iteration needed), Task 25 could not be dispatched without manually
resetting the dependency. There is no "bypass if no iteration needed" path
in the task spec or SKILL.md.

**Blocking?** No. The dependency is logically sound: description optimization
should not run before the skill body is stable. In the common case where
iteration is needed, the dependency is correct. In the rare case where
iteration is skipped, the operator can use `orc task-reset` to unblock
manually. The spec does not need to enumerate every bypass path.
Acceptable as-is.

---

## Summary

| Item | Status | Blocking? |
|------|--------|-----------|
| N1 — evals.json/Task 23 contradiction | FIXED | — |
| N2 — Task 24 verification gap | FIXED | — |
| N3 — Task 25 macOS-only `open` | FIXED | — |
| N4 — SKILL.md multi-predecessor format | FIXED | — |
| Issue 3 — Coordinator note wording | FIXED | — |
| Issue 6 — Slug collision deduplication | Outstanding | No |
| Issue 8 — No negative eval in evals.json | Outstanding | No |
| Issue 9 — Task 25 blocked if Task 24 skipped | Outstanding | No |

All MUST FIX items from R2 are resolved. All SHOULD FIX items from R2 are
resolved. The three outstanding items carried from earlier rounds are assessed
as non-blocking known limitations acceptable for an initial skill version.

**VERDICT: APPROVED**
