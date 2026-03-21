# QA Review Round 2 — plan-to-tasks Skill and Backlog Tasks 21–25

Reviewed files:
- `skills/plan-to-tasks/SKILL.md`
- `skills/plan-to-tasks/evals/evals.json`
- `backlog/21-plan-to-tasks-skill-draft.md`
- `backlog/22-plan-to-tasks-test-prompts.md`
- `backlog/23-plan-to-tasks-run-evals.md`
- `backlog/24-plan-to-tasks-review-iterate.md`
- `backlog/25-plan-to-tasks-optimize-description.md`
- `skills/create-task/SKILL.md` (context)
- `backlog/TASK_TEMPLATE.md` (context)
- `AGENTS.md` (context)

Previous round review: `skills/plan-to-tasks-workspace/review/qa.md`

---

## Status of Previously Reported Issues

### Previously MUST FIX

**1. No-plan edge case under-specified — FIXED**

SKILL.md Step 0 now includes a precise definition of what counts as a valid plan ("a numbered or phased list where each item has an identifiable title"), explicit negative examples ("a single unlabelled bullet list, a prose paragraph, or a one-sentence description does not count"), and an exact question to ask: "I don't see a numbered plan in our conversation. Could you paste the steps you'd like converted to tasks?" This is fully actionable for an agent.

**2. Single-step plan has no base case — FIXED**

SKILL.md Step 0 now contains: "If only one step is present: that is a valid (single-task) plan. Skip dependency inference (trivially Independent) and proceed to the preview with one row." The base case is explicit, the correct action is named, and the preview path is not bypassed.

**3. Coordinator auto-blocking not addressed in the skill — PARTIALLY FIXED, NEW CONCERN**

SKILL.md Step 4 now includes a "Coordinator note" paragraph: "If the live coordinator is running, it may auto-claim and dispatch a task as soon as it is registered. To prevent a task from being dispatched before its dependencies are registered, write and register all task files in sequence from first to last before the coordinator has a chance to act. If tasks get auto-dispatched and blocked, use `orc task-reset <ref>` after all tasks are registered to unblock them."

The core problem is acknowledged and the recovery instruction (`orc task-reset`) is named. However, this remains a SHOULD FIX gap: the guidance assumes that writing+registering N before N+1 is fast enough to prevent the coordinator from acting, but the coordinator tick is asynchronous and there is no guaranteed ordering. The instruction "write and register all task files in sequence from first to last before the coordinator has a chance to act" is a race-condition mitigation, not a serialization guarantee. An agent following this may still experience mid-batch auto-dispatch if the coordinator ticks between two registration calls. The fix is an improvement but the framing ("before the coordinator has a chance to act") is optimistic and does not give the agent a reliable procedure for verifying that no race occurred. This is now a SHOULD FIX severity rather than MUST FIX.

**4. Partial-batch failure — no recovery path specified — FIXED**

SKILL.md Step 4 now specifies: "Do not stop the batch on a single registration failure. On failure: emit a warning in your response text (format: `⚠ REGISTRATION FAILED: <ref> — <error>`), continue writing the remaining tasks, and include all failed refs in the final Step 5 report." Step 5 adds: "If any newly created ref fails sync, list it explicitly and say: `To recover: say 'register <ref>' to retry registration.`" The recovery instruction is specific and actionable. Resolved.

**5. evals.json assertions field naming mismatch + Task 22 criterion violated — PARTIALLY FIXED, RESIDUAL ISSUE**

Field naming is now consistent: the evals.json file uses `expectations` throughout, and Task 22's acceptance criterion (line 69) now reads "No `expectations` field present — those are added in Task 23." The naming inconsistency between "assertions" and "expectations" is resolved.

However, the current `evals.json` still contains a fully populated `expectations` array in all three evals (eval 1 has 7 entries, eval 2 has 7 entries, eval 3 has 7 entries). Task 22's acceptance criterion explicitly requires: "No `expectations` field present — those are added in Task 23." The committed file violates its own task's acceptance criterion. Task 23's Goal 2 says "Must draft `expectations` assertions for each eval while runs are in progress (not after)" — implying expectations are not yet in the file at the start of Task 23. An agent executing Task 23 will find expectations already present and must decide whether to skip, overwrite, or validate. No instruction handles this pre-populated state. This is a MUST FIX: the evals.json file is in a state that contradicts the task spec that produced it, and the task spec for Task 23 has not been updated to reflect the pre-populated state.

---

### Previously SHOULD FIX

**6. Ambiguous/duplicate step titles not handled (slug collision) — NOT FIXED**

SKILL.md still has no deduplication rule for identical step titles. If a plan contains two steps with the same title (e.g. "Write tests" appears at steps 2 and 3), the kebab-case slug rule inherited from create-task would produce two files with the same name. The second write would silently overwrite the first. No eval covers this case, and no acceptance criterion in any task (21–25) addresses it.

**7. User cancellation at preview not handled — FIXED**

SKILL.md Step 3 now includes: "If the user cancels (says 'no', 'cancel', 'stop', 'never mind', or similar): stop immediately. Do not write any files. Report: 'Cancelled — no tasks were created.'" This is specific and actionable. Resolved.

**8. No negative-trigger eval in evals.json — NOT FIXED**

All three evals remain positive-trigger cases. There is no eval where the skill should not fire (e.g. a prompt to create a single task, or a request to show a plan). The description optimization in Task 25 will generate 20 trigger-eval queries separately, but these are not part of the evals.json harness and are not captured in benchmark results. Without a negative eval in evals.json, the standard harness has no recall/precision signal for false positives.

**9. Task 25 dependency on Task 24 over-constrained (dep on Task 21 redundant) — NOT FIXED**

Task 25's `depends_on` references only `general/24-plan-to-tasks-review-iterate`, which transitively depends on Tasks 23, 22, and 21. The transitive chain makes the dependency correct for the stated purpose (optimize after iteration is complete), but the original concern stands: if Task 24 is skipped because eval results were satisfactory after Task 23, Task 25 is blocked. The current task specs provide no pathway to advance Task 25 if Task 24 is deemed unnecessary. A note or alternative trigger condition is missing.

**10. Hardcoded plugin path with content-hash in Task 23 and 25 — FIXED**

Task 23's Implementation now includes: "Use the actual directory name found — the path contains a content-hash component that changes when the plugin is updated. Do not hardcode the hash." Task 25's Implementation includes the same guidance: "Use the actual directory name found — the hash changes when the plugin is updated." Neither task hardcodes a hash in its instructions. The example commands in Task 25 Step 2 still show `<hash>` as a placeholder, which is correct. Resolved.

**11. Task 24 acceptance criteria not fully binary — PARTIALLY FIXED**

Task 24's acceptance criteria now include:
- "SKILL.md changes address feedback categories (not individual test-case patches) — each change covers a class of failure, not a single prompt."

This is an improvement in phrasing over the previous version but remains a subjective quality judgment. "Covers a class of failure" is not a binary observable state — a reviewer cannot deterministically pass or fail this. The other criterion "All feedback fields are empty, OR user has explicitly confirmed satisfaction, OR 5 rounds have been completed" remains a valid three-way disjunction with only one deterministic branch (5 rounds). The other two branches require external state (the user's satisfaction or emptied feedback fields) that is not independently verifiable by an automated agent. This is a SHOULD FIX residual.

---

## New Issues Found in Round 2

### N1. MUST FIX — evals.json `expectations` present while Task 22 prohibits them (regression clarification)

This is elaborated from issue 5 above because it has operational consequences beyond naming. The current evals.json has `expectations` arrays added. Task 23's Goal 2 says assertions must be drafted "while runs are in progress (not after)." An agent executing Task 23 will open evals.json and find it already has expectations. If the agent proceeds without overwriting, it treats pre-existing expectations as the canonical assertions — but these were written before any eval runs, which violates the intent of Task 23. If the agent overwrites them, it may discard expectations that are correct. Task 23 has no branch for "expectations already present." This is a genuine workflow ambiguity that can cause a Task 23 run to silently use stale expectations or lose carefully crafted ones.

**Fix required:** Either remove `expectations` from evals.json (restoring compliance with Task 22's acceptance criterion), or update Task 23 to say "if `expectations` are already present in evals.json, treat them as the baseline and update/augment them as runs complete."

### N2. SHOULD FIX — Task 24 Verification step runs `npm test` without a stated reason

Task 24's Verification section contains:
```bash
nvm use 24 && npm test
```

Task 24 produces only a revised `skills/plan-to-tasks/SKILL.md` — a markdown file. There are no code changes. `npm test` is the full test suite (per AGENTS.md: "Vitest"). Running it is not wrong, but it has no targeted value for a task whose output is a markdown file. More importantly, this may confuse an agent into thinking `npm test` is the meaningful verification gate, when the real gate is the eval viewer feedback loop described in the task body. The create-task SKILL.md states: "Verification: `nvm use 24 && npm test` always" but also says to add targeted verification commands before the full suite. For a markdown-only task, there is no targeted command, and just `npm test` is misleading. Task 21 and Task 22 handle this correctly by naming the actual check (e.g. `cat skills/plan-to-tasks/SKILL.md` and `python3 -m json.tool`). Task 24's verification section should specify the actual human/eval verification steps and then note `npm test` is a safety check, not the primary gate.

### N3. SHOULD FIX — Task 25 Step 2 uses `open` command which is macOS-only

Task 25 Implementation Step 2 ends with:
```bash
open /tmp/eval_review_plan-to-tasks.html
```

`open` is a macOS-specific command. In a headless Linux CI environment or a non-macOS agent session, this will fail. Task 23 accounts for this ("Launch viewer (static HTML for headless environments)"), but Task 25 Step 2 has no equivalent fallback. An agent running on Linux will fail this step and may block waiting for user review that cannot proceed. The fix is to add a note that on non-macOS, the file should be reported to the user with its path and they can open it manually.

### N4. SHOULD FIX — SKILL.md Step 4 dependency line instruction is incomplete for multi-predecessor deps

SKILL.md Step 4 item 2 says:
> "Write `Depends on Task <N>.` / `Blocks Task <N+1>.` / `Independent.` in the body"

This covers one predecessor and one successor. However, eval 3 in evals.json expects Step 5 to depend on Steps 2, 3, and 4 — a multi-predecessor case. The instruction pattern `Depends on Task <N>.` does not cover `Depends on Tasks 2, 3, and 4.` format. Similarly, the preview table example in Step 3 shows "Depends on 21, 22" as a multi-predecessor format, but the body text instruction only names the singular form. An agent following Step 4's text for a multi-predecessor task will write a non-standard dependency line. This is inconsistent with the preview table instruction which does show the multi-dep format.

### N5. MINOR — SKILL.md Step 1.1 shell fallback counts files in backlog/ including non-task files

The fallback command is:
```bash
ls backlog/ | grep -oE '^[0-9]+' | sort -n | tail -1 | xargs -I{} expr {} + 1
```

The `backlog/` directory contains `TASK_TEMPLATE.md` and potentially other non-task files. This file's filename (`TASK_TEMPLATE.md`) does not start with a number, so `grep -oE '^[0-9]+'` correctly excludes it. However, any file that does start with a number but is not a task spec (e.g. a backup like `21-backup.md`) would be included in the count. This is a minor robustness issue that was also present in round 1 (it was noted in the previous review as finding 13). Still not fixed, but still MINOR severity.

---

## Conformance with TASK_TEMPLATE.md

Checking all five task specs against TASK_TEMPLATE.md requirements:

**Task 21:** Compliant. Has all required sections in correct order. Tests section correctly states "Not applicable — task output is a markdown skill file, not executable code." Status `done` is acceptable for a completed task.

**Task 22:** Compliant on structure. Non-compliant on content: acceptance criterion says "No `expectations` field present" but evals.json has expectations. Status is `done` despite the output file violating the acceptance criterion.

**Task 23:** Compliant. Correct section order. Tests section uses the approved non-applicable language. Status `done`.

**Task 24:** Mostly compliant. Verification section runs `npm test` for a markdown-only task (see N2). No `## Risk / Rollback` section — the task does not mutate state files directly, so this is acceptable per the template rules. Status `done`.

**Task 25:** Compliant on structure. Contains the approved "Not applicable" Tests entry. Has non-binary acceptance criteria noted above. Contains `open` command without fallback (see N3). Status `done`.

All five tasks are missing `priority` field in the context of the template — actually they do all have `priority: normal` in frontmatter. All five have correct frontmatter structure.

---

## Summary Table

| # | Severity | Status vs R1 | Issue |
|---|----------|--------------|-------|
| 1 | MUST FIX | Fixed | No-plan edge case under-specified |
| 2 | MUST FIX | Fixed | Single-step plan base case missing |
| 3 | MUST FIX | Downgraded to SHOULD FIX | Coordinator auto-blocking: acknowledged but race-condition remains |
| 4 | MUST FIX | Fixed | Partial-batch failure, no recovery path |
| 5 | MUST FIX | Partially fixed — naming fixed, evals.json state still violates Task 22 | expectations field present despite Task 22 prohibition |
| 6 | SHOULD FIX | Not fixed | Duplicate step title slug collision not handled |
| 7 | SHOULD FIX | Fixed | User cancellation at preview not handled |
| 8 | SHOULD FIX | Not fixed | No negative-trigger eval in evals.json |
| 9 | SHOULD FIX | Not fixed | Task 25 over-constrained dependency (Task 24 skip path absent) |
| 10 | SHOULD FIX | Fixed | Hardcoded plugin content-hash paths |
| 11 | SHOULD FIX | Partially fixed | Task 24 acceptance criteria still not fully binary |
| 12 | MINOR | Fixed | "assertions" vs "expectations" naming inconsistency |
| 13 | MINOR | Not fixed | No guard against concurrent backlog writes |
| N1 | MUST FIX | New | evals.json `expectations` present contradicts Task 22 acceptance criterion and creates Task 23 workflow ambiguity |
| N2 | SHOULD FIX | New | Task 24 Verification uses `npm test` with no meaningful gate for markdown output |
| N3 | SHOULD FIX | New | Task 25 uses macOS-only `open` command without Linux fallback |
| N4 | SHOULD FIX | New | SKILL.md Step 4 dependency-line instruction only covers singular predecessor, inconsistent with multi-dep preview format |
| N5 | MINOR | Carry-forward | Shell fallback for next_task_seq fragile for non-task-spec files |

### Remaining MUST FIX (blocking approval)

1. **Issue 5 / N1:** `evals.json` has `expectations` arrays present. Task 22's acceptance criterion explicitly prohibits this. Task 23 has no branch for pre-populated expectations. Either remove expectations from evals.json to restore Task 22 compliance, or update Task 23 to handle the pre-populated state explicitly.

### Remaining SHOULD FIX (non-blocking but recommended)

- Issue 3 (downgraded): Coordinator race condition mitigation is noted but not reliable
- Issue 6: Duplicate step title collision
- Issue 8: No negative-trigger eval
- Issue 9: Task 25 blocked if Task 24 is skipped
- Issue 11: Task 24 criteria partially subjective
- N2: Task 24 verification misleading for markdown-only output
- N3: Task 25 `open` command macOS-only
- N4: Multi-predecessor dependency line format inconsistency in SKILL.md Step 4

---

**VERDICT: NEEDS CHANGES**

The single remaining MUST FIX (evals.json `expectations` present while Task 22 prohibits them, and Task 23 has no branch for this pre-populated state) must be resolved before approval. The file is in a state that contradicts its generating task's acceptance criteria and introduces genuine workflow ambiguity for Task 23.
