# Architect Review — plan-to-tasks — Round 3

**Reviewer role:** Design correctness, dependency graph validity, composition patterns, structural soundness.
**Round context:** R2 was APPROVED. This is a confirmatory pass on targeted R3 changes.

**Files reviewed:**
- `skills/plan-to-tasks/SKILL.md`
- `skills/plan-to-tasks/evals/evals.json`
- `backlog/21-plan-to-tasks-skill-draft.md`
- `backlog/22-plan-to-tasks-test-prompts.md`
- `backlog/23-plan-to-tasks-run-evals.md`
- `backlog/24-plan-to-tasks-review-iterate.md`
- `backlog/25-plan-to-tasks-optimize-description.md`

**Context files:** `skills/create-task/SKILL.md`, `AGENTS.md`, `backlog/TASK_TEMPLATE.md`

---

## R3 Change Verification

### Change 1 — SKILL.md Step 4 skip list: explicit inclusion of "Register in backlog.json"

**Location:** SKILL.md line 135

> All other create-task steps — including the "Register in backlog.json" step — apply unchanged for each task.

**Assessment: Correct and well-placed.**

The parenthetical clarification removes a previously ambiguous situation: when an agent reads "Which create-task steps to skip in batch mode," they could have interpreted the registration step as potentially skippable since it wasn't explicitly named. The added text makes clear that registration is in-scope for each task. The phrasing is minimal and does not duplicate registration procedure — it only points to where the procedure lives (create-task SKILL.md). No contradiction with create-task's registration workflow.

---

### Change 2 — SKILL.md Step 4 dependency line: multi-predecessor format

**Location:** SKILL.md lines 139–147

The dependency line instruction now reads:
- Single predecessor: `Depends on Task <N>.`
- Multiple predecessors: `Depends on Tasks <N1>, <N2>, and <N3>.`
- Has a successor: append `Blocks Task <N+1>.`
- No dependencies: `Independent.`

**Assessment: Correct and complete.**

The addition of the multiple-predecessors format is well-specified. It follows Oxford-comma convention (`<N1>, <N2>, and <N3>`), which is consistent with how Task 23's body line reads: "Depends on Tasks 21 and 22." (two items — no Oxford comma needed). The instruction also correctly specifies that `depends_on` in frontmatter must list multiple refs when there is a real multi-predecessor dep, and that the MCP/CLI prohibition still applies. No ambiguity introduced.

One minor observation: the example uses three-element format (`<N1>, <N2>, and <N3>`) while Task 23's existing body uses two-element format (`Tasks 21 and 22`). Both are consistent with English grammar conventions — the format adapts naturally for any count. Not a defect.

---

### Change 3 — SKILL.md Coordinator note: "if blocked" → "if auto-claimed or auto-dispatched"

**Location:** SKILL.md lines 121–125

> If tasks get auto-claimed or auto-dispatched, use `orc task-reset <ref>` after all tasks are registered to reset them to `todo`.

**Assessment: Correct improvement.**

The previous "if blocked" phrasing was misleading — "blocked" is a specific orchestrator lifecycle state (distinct from `todo`, `claimed`, `in_progress`). The revised phrasing `auto-claimed or auto-dispatched` maps precisely to the two coordinator actions that can preempt dependency registration. This aligns with AGENTS.md's task lifecycle table: `todo → claimed` is set by the coordinator on delegate. The recovery action (`orc task-reset`) correctly targets a task in `claimed` or `in_progress` state back to `todo`. Structurally sound.

---

### Change 4 — Task 23: Goal 2 updated for pre-populated expectations

**Location:** `backlog/23-plan-to-tasks-run-evals.md` line 58

> If `expectations` are already present in `evals.json`, treat them as the baseline — review and augment them as runs complete rather than overwriting.

**Assessment: Correct.**

The prior text implied assertions must always be drafted during this task from scratch. Since the file is now being authored after Task 23 was completed, the `evals.json` already has `expectations`. The revised Goal 2 correctly handles the "expectations already present" case without contradicting the original intent: a worker must still engage with the assertions (review/augment) rather than blindly skipping them. The parallel update to Step 3 (lines 87–98) aligns: "If `expectations` are not yet present... draft them now. If `expectations` are already present... review them... do not blindly overwrite." The two-condition structure is logically complete and non-contradictory.

This also resolves the R2 minor observation about Task 22's stale "no `expectations` field" AC — Task 23's spec now explicitly acknowledges the committed state. That AC in Task 22 is still stale text, but Task 22 is `status: done` and immutable, so this is acceptable.

---

### Change 5 — Task 24: Verification section gained python3 frontmatter check

**Location:** `backlog/24-plan-to-tasks-review-iterate.md` lines 100–108

```bash
python3 -c "
import re, pathlib
text = pathlib.Path('skills/plan-to-tasks/SKILL.md').read_text()
assert text.startswith('---'), 'Missing frontmatter'
print('Frontmatter OK')
"
nvm use 24 && npm test
```

**Assessment: Correct and useful.**

This addresses the R2 MINOR observation that Task 24's verification was just `npm test`, which produces no useful signal for a markdown-only task. The added python3 check provides a fast, meaningful smoke test: it verifies that the SKILL.md frontmatter hasn't been accidentally stripped during iteration. The check is minimal and correct — `startswith('---')` is the right predicate for YAML frontmatter detection. It imports `re` but does not use it; this is harmless but slightly noisy. Not a defect.

The `nvm use 24 && npm test` remains below the python3 check — the full suite still runs, satisfying create-task's rule that `nvm use 24 && npm test` must always appear in Verification.

---

### Change 6 — Task 25: `open` command gained Linux fallback comment

**Location:** `backlog/25-plan-to-tasks-optimize-description.md` lines 98–101

```bash
# macOS:
open /tmp/eval_review_plan-to-tasks.html
# Linux / headless: report path to user instead:
# echo "Review file written to /tmp/eval_review_plan-to-tasks.html — open in browser to review queries"
```

**Assessment: Correct.**

The prior version had only `open ...` with no fallback guidance. Since eval runs may occur on Linux or headless CI environments where `open` does not exist, the comment-based fallback is the appropriate pattern (it avoids branching in what is essentially instruction prose). The comment is self-explanatory and consistent with how the skill-creator ecosystem typically documents platform differences in task specs.

---

### Change 7 — `<hash>` placeholder comments in Tasks 23 and 25

**Location:** Task 23 line 79, Task 25 lines 86, 110

```bash
SKILL_CREATOR=~/.claude/plugins/cache/claude-plugins-official/skill-creator/<HASH>/skills/skill-creator
# ^^^ Replace <HASH> with the actual directory name from the ls output above
```

**Assessment: Correct and important.**

These placeholders replace what were previously either missing or potentially hardcoded paths. The pattern is:
1. `ls` the directory first (shown in "Start here" / Step 2)
2. Use the actual hash found — do not hardcode
3. The `<HASH>` placeholder makes the substitution requirement explicit

This is a best practice for plugin paths that change on update. The comment on every usage site prevents a worker from copy-pasting a stale hash from a previous run output. Both tasks (23 and 25) consistently apply the pattern in all places where the path is used. The approach is architecturally sound for a path that cannot be statically resolved at spec-writing time.

---

## Dependency Graph — Confirmatory Check

The R3 changes do not modify any frontmatter `depends_on` fields or body dependency lines. Graph as confirmed in R2 is unchanged:

```
21 (Independent) ──────────────────────────────────────────────► 23 → 24 → 25
22 (Independent) ──────────────────────────────────────────────►
```

| Task | Frontmatter `depends_on` | Body dependency line | Correct? |
|------|--------------------------|----------------------|----------|
| 21   | (absent)                 | "Independent."       | YES |
| 22   | (absent)                 | "Independent. Blocks Task 23." | YES |
| 23   | `[general/21-..., general/22-...]` | "Depends on Tasks 21 and 22. Blocks Task 24." | YES |
| 24   | `[general/23-...]`       | "Depends on Task 23. Blocks Task 25." | YES |
| 25   | `[general/24-...]`       | "Depends on Task 24." | YES |

No cycles. No transitive redundancies. No frontmatter/body mismatches.

---

## Skill Composition — Confirmatory Check

The new "All other create-task steps — including the 'Register in backlog.json' step — apply unchanged" clarification in Step 4 does not alter the composition model. The delegation-by-reference pattern remains intact. The skip list is additive (Step 0, Step 0.5, Output Contract per task) and the inclusion list now makes registration explicit. No duplication introduced.

---

## New Issues Found

None. All seven R3 changes are individually correct and collectively consistent. No new structural, dependency, or composition defects were introduced.

The one pre-existing minor observation (unused `import re` in Task 24's python3 snippet) is trivially harmless.

---

## Summary

All seven R3 changes are correct:
1. Registration step explicitly included in skip-list complement — removes ambiguity.
2. Multi-predecessor format added — complete and consistent with existing task body text.
3. Coordinator note terminology corrected — matches orchestrator lifecycle semantics.
4. Task 23 Goal 2 / Step 3 handle pre-populated expectations — logically complete.
5. Task 24 python3 frontmatter check — addresses R2 minor, provides meaningful signal.
6. Task 25 Linux fallback comment — correct defensive practice for headless environments.
7. `<HASH>` placeholders in Tasks 23 and 25 — correctly applied at all usage sites.

Dependency graph is unchanged from R2, remains valid. Skill composition remains clean.

**VERDICT: APPROVED**
