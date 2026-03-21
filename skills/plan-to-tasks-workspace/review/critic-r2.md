# Critic Review — Round 2
**Files reviewed:** SKILL.md, evals/evals.json, backlog/21–25

---

## Round 1 Issues — Verification

### Previously MUST FIX — Status

1. **Description triggers overlap with `create-task` skill** — FIXED. The description now draws a clear boundary: "a plan was already printed AND the user now wants all of its steps turned into task files." The create-task description still says "batch planning (multiple dependent tasks from a single request)" which is an adjacent concern, but the plan-to-tasks description explicitly excludes "provides an inline list without a prior plan." The boundary is now sufficiently sharp.

2. **"read create-task SKILL.md now" not a concrete first action** — FIXED. The skill now uses `Read tool` explicitly: "read `skills/create-task/SKILL.md` now using the Read tool."

3. **Step 4 didn't enumerate which create-task steps to skip** — FIXED. Step 4 now has a dedicated "Which create-task steps to skip in batch mode" subsection listing Step 0, Step 0.5, and the Output Contract.

4. **Evals lacked `conversation_context` fixtures** — FIXED. All three evals now have `conversation_context` fields with realistic numbered plans.

5. **Tasks 21–25 lacked `## Tests` section** — FIXED. All five tasks now include a `## Tests` section with the approved "Not applicable" prose.

6. **Task 22 had spurious `depends_on` on Task 21** — FIXED. Task 22 frontmatter has no `depends_on` field; body says "Independent."

7. **`--depends-on` prohibition didn't cover MCP path** — FIXED. Step 4.2 now says: "Do **not** pass `--depends-on` to `task-create` CLI or `depends_on` to `mcp__orchestrator__create_task`."

8. **No-plan edge case under-specified** — FIXED. Step 0 now includes explicit instruction for no-plan case and asks the user to paste.

9. **Single-step plan base case missing** — FIXED. Step 0 now handles single-step plans explicitly: "Skip dependency inference (trivially Independent) and proceed to the preview with one row."

10. **Coordinator auto-blocking not addressed** — FIXED. Step 4 now has a "Coordinator note" block describing the race condition and `orc task-reset` recovery.

11. **Partial-batch failure recording mechanism was vague** — FIXED. Step 4.3 now specifies: emit `⚠ REGISTRATION FAILED: <ref> — <error>`, continue remaining tasks, include all failed refs in Step 5 report.

### Previously SHOULD FIX — Status

- **Step 1 shell fallback misleadingly presented** — FIXED. Shell fallback is now clearly labeled "Shell fallback (only if MCP is unavailable)."
- **$ARGUMENTS blank case not handled** — FIXED. A comment now reads: "If $ARGUMENTS is blank, no feature override was given — resolve the feature via Step 1.2."
- **User cancellation at preview step not handled** — FIXED. Step 3 now includes explicit cancel handling.
- **`## Tests` may be omitted for non-code tasks instruction missing** — FIXED. Step 4.4 explains when to use the "Not applicable" line.
- **Reference to create-task Step 0 for slug construction** — FIXED. Step 3 now says "see create-task Step 0 for slug construction" and Step 4.1 references "create-task Step 0's slug rule exactly."
- **Task 22 AC said "assertions" but field is "expectations"** — FIXED. Task 22 ACs now use "expectations" consistently.
- **Task 25 redundant `depends_on` on Task 21** — FIXED. Task 25 now only depends on Task 24.
- **Context subsections (Current state, Desired state, Start here) missing from tasks 21–25** — FIXED. All five tasks now include all three Context subsections.
- **Hardcoded plugin hash in tasks 23, 25** — FIXED. Task 23 now says "Use the actual directory name found — the path contains a content-hash component." Task 25 uses `<hash>` as a placeholder and notes the hash changes.
- **Task 24 ACs not fully binary** — PARTIALLY FIXED (see new finding F3 below).

---

## New Findings — Round 2

### MUST FIX

**F1 — evals.json `expectations` field contradicts Task 22 AC (schema contract mismatch)**

Task 22 AC says: "No `expectations` field present — those are added in Task 23." But all three evals in `evals.json` already contain `expectations` arrays. This directly violates the stated contract that Task 23 adds assertions. The current state of the file either means Task 22 was incorrectly executed (adding expectations it wasn't supposed to), or the AC is stale and should have been updated to reflect that expectations are already present. Either way, the AC and the actual file are in conflict. A future executor of Task 23 will be confused about whether to add, replace, or treat them as already done.

**Severity: MUST FIX** — the Task 22 AC at line 69 says "No `expectations` field present" but the file clearly has one in all three evals. One of these must be corrected.

---

**F2 — Eval 1 dependency inference expectation is arguably wrong**

Eval 1, expectation at index 5: "Step 2 (tests) is marked as depending on Step 1 (the middleware) — not Independent — because tests require the middleware to exist."

The SKILL.md Step 2 rule explicitly states: "Two steps that work on independent concerns can be executed in any order — default to Independent unless there is a real logical reason to serialize." The eval's context shows Step 2 writes *tests* for the middleware from Step 1. Whether test files require the implementation to exist first is actually debatable — a test file can be written before the implementation exists (TDD). The skill's dependency rule focuses on whether one step "consumes an output" produced by the prior step. Test files don't strictly consume the implementation as an input to their *authoring*. The expectation is borderline and could cause a valid skill invocation to fail evaluation.

**Severity: MUST FIX** — eval expectations should be unambiguous to avoid false negatives during grading. Either add a comment explaining why this is a dependency in this eval's specific context, or re-word the plan step to make the dependency unambiguous (e.g. "Step 2 — Write tests and verify they pass against the middleware from Step 1").

---

**F3 — Task 24 Verification runs `npm test` but no executable code is touched**

Task 24 Verification block (line 101–103) says:
```bash
nvm use 24 && npm test
```

Task 24 only modifies `skills/plan-to-tasks/SKILL.md` — a markdown file. Running the full test suite is the correct repo-wide gate, but the Verification block contains *only* `npm test` with no targeted verification command. The create-task SKILL.md quality gate says "Verification: Full-suite command present; smoke checks included when schema/state/CLI touched." A targeted check (e.g. confirming the file parses, has no YAML frontmatter errors) would be appropriate here before the full suite. More importantly, this is inconsistent with tasks 21, 22, 23 which all have a targeted command. Minor inconsistency but misleading.

**Severity: SHOULD FIX** — add a targeted verification command before `npm test`, consistent with the pattern in Tasks 21/22/23.

---

### SHOULD FIX

**F4 — Step 4 "batch mode" instruction says "write each file and register it immediately" but "Which steps to skip" omits the registration step number from create-task**

The "Which create-task steps to skip" list in Step 4 omits the "Register in backlog.json" step from create-task as a step that is *not* skipped. A batch executor reading this list might infer that registration is also skipped (since several other steps are). The instruction "then continue to the next" in Step 4.3 implies registration happens, but it's not stated explicitly in the skip list. The list should clarify: "All other create-task steps, including the 'Register in backlog.json' step, apply unchanged."

**Severity: SHOULD FIX** — add one line to the skip list clarifying that registration is not skipped.

---

**F5 — Task 22 Goal 5 contradicts the actual file and Task 23's scope**

Task 22 Goal 5 (line 51): "Must not include an `expectations` field — assertions are added during the eval run in Task 23."

As noted in F1, the file already has `expectations`. If the intent is that Task 22 produced a file without expectations and Task 23 added them, the task spec should reflect that Task 22 is done with that state, and the current state of `evals.json` (with expectations) is a post-Task-23 artifact. The task being marked `status: done` means this is a historical record — but the Goal and AC still say "no expectations field" which creates confusion. Since Task 22 is `done`, this is a documentation accuracy issue.

**Severity: SHOULD FIX** — add a note that the `expectations` field was added by Task 23 (now present in the file), so future readers of the task history understand why the done task's AC appears violated.

---

**F6 — SKILL.md Step 0 definition of "plan" is not exhaustive enough**

Step 0 says a "single unlabelled bullet list, a prose paragraph, or a one-sentence description does not count as a plan." However, it doesn't address a numbered list without headings/titles (e.g. `1. Write auth.js\n2. Add tests\n3. Deploy`). The skill says "Or a simpler numbered list: `1. Do X`, `2. Do Y`, etc." which implies these are valid. But a numbered list of one-word items with no body content is at the boundary. The rule is implicitly handled but the statement "each item has an identifiable title (and usually a description)" could be made explicit: a numbered list is valid even without description bodies, as long as each item has a title.

**Severity: MINOR** — no behavioral gap, but the definition could be slightly more explicit.

---

**F7 — Task 23 Step 2 shell snippet still shows `<hash>` placeholder in the variable assignment**

Task 23 Implementation Step 2 (line 79):
```bash
SKILL_CREATOR=~/.claude/plugins/cache/claude-plugins-official/skill-creator/<hash>/skills/skill-creator
```

The `<hash>` placeholder is still present. The preceding instruction correctly says "Use the actual hash directory name found — do not hardcode," but the code snippet contradicts the intent by showing a literal `<hash>` token that an agent might copy verbatim. This was noted as fixed in Round 1 (the `ls` command now appears before), but the assignment line still contains the literal `<hash>` marker.

**Severity: MINOR** — the instruction text is correct but the code block is misleading. Could be improved with a comment like `# Replace <hash> with actual directory name from ls output above`.

---

**F8 — Task 25 Step 2 and Step 3 still use hardcoded `<hash>` in bash snippets**

Similar to F7, Task 25 Implementation Step 2 (line 86) and Step 3 (line 106) both still show `SKILL_CREATOR=~/.claude/plugins/cache/claude-plugins-official/skill-creator/<hash>/skills/skill-creator`. The "Start here" section does instruct the agent to locate the actual path first, and both snippets have comments saying to replace `<hash>`, but the code blocks themselves look like direct-copy-paste commands with a literal placeholder. Agents using these blocks directly will fail.

**Severity: MINOR** — the structure is correct but the code blocks should add inline comments marking `<hash>` as a placeholder substitution, not a literal value.

---

### MINOR

**F9 — `orc task-reset` recovery instruction in Step 4 is incomplete**

The coordinator note in Step 4 says: "If tasks get auto-dispatched and blocked, use `orc task-reset <ref>` after all tasks are registered to unblock them." The AGENTS.md lifecycle shows that `task-reset` transitions `claimed/in_progress/blocked → todo`. A task that was auto-dispatched and started would be `in_progress`, not `blocked`. The instruction should say "auto-dispatched or auto-claimed" and note that `task-reset` handles those states too.

**Severity: MINOR** — technically correct (task-reset handles all three states) but the framing says "if blocked" which is imprecise.

---

**F10 — Eval 3 expectation index 4 says "Step 5 depends on Steps 2, 3, and 4" but the plan body only mentions Steps 2, 3 in the deploy comment**

Eval 3, expectation at index 4: "Step 5 depends on Steps 2, 3, and 4 (deploy requires all jobs to pass)." Looking at the Step 5 body in `conversation_context`: "Add all required secrets to GitHub repository settings so the deploy yamls from Steps 2 and 3 and the CI job from Step 4 can authenticate." This does logically require Steps 2, 3, and 4, so the expectation is correct. However, the dependency on Step 1 is not mentioned in the expectation. Step 4 depends on Step 1 (expanding CI yaml), and Step 5 depends on Step 4, so there is a transitive dependency. The expectations only capture direct deps, which is fine — just noting that the transitive chain via Step 4 → Step 1 is not explicit in the eval expectations. Not a bug but worth being clear this is direct-dep only.

**Severity: MINOR** — no action needed, informational.

---

## Summary Table

| ID | Severity | File | Description | Status |
|----|----------|------|-------------|--------|
| F1 | MUST FIX | evals.json + backlog/22 | `expectations` field present in evals.json contradicts Task 22 AC "no expectations field" | NEW |
| F2 | MUST FIX | evals/evals.json | Eval 1 dep-inference expectation for Step 2 is ambiguous (TDD argument) | NEW |
| F3 | SHOULD FIX | backlog/24 | Verification block missing targeted check; only has `npm test` | NEW |
| F4 | SHOULD FIX | SKILL.md | Skip list in Step 4 doesn't clarify that registration step is NOT skipped | NEW |
| F5 | SHOULD FIX | backlog/22 | Goal 5 and AC say "no expectations field" but file now has one (historical accuracy) | NEW |
| F6 | MINOR | SKILL.md | Step 0 plan definition edge case with no-body numbered lists slightly ambiguous | NEW |
| F7 | MINOR | backlog/23 | Shell snippet still shows literal `<hash>` placeholder without substitution note | NEW |
| F8 | MINOR | backlog/25 | Two shell snippets still show literal `<hash>` placeholder | NEW |
| F9 | MINOR | SKILL.md | Coordinator note says "if blocked" but should say "if auto-claimed or blocked" | NEW |
| F10 | MINOR | evals/evals.json | Eval 3 Step 5 transitive dep via Step 1 not captured (informational, no action needed) | NEW |

---

**VERDICT: NEEDS CHANGES**

Two MUST FIX issues remain: the `expectations` field conflict between Task 22's AC and the actual evals.json state (F1), and the ambiguous dependency inference expectation in Eval 1 that could produce false-negative grading (F2). These need resolution before approval.
