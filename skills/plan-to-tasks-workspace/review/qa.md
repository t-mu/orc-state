# QA Review — plan-to-tasks Skill and Backlog Tasks 21–25

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

---

## Findings

### 1. MUST FIX — No plan in conversation is under-specified

SKILL.md Step 0 says "If no numbered plan is visible in the conversation, ask the user to paste or restate it." This single sentence is the entire handling for a missing plan. There is no guidance on what constitutes a "numbered plan" — a bulleted list with no numbers, a prose description of steps, or a markdown table could all plausibly be plans. The instruction for what to ask, how to phrase the question, or what to do if the user pastes an ambiguous block is absent. An agent following the skill as written may either silently misparse non-standard input or stall with a vague question. The acceptance criteria in Task 21 do not test this path at all — there is no criterion for "skill correctly detects and handles absent plan." evals.json has no negative eval (a trigger prompt with no plan in the conversation) to catch this regression.

### 2. MUST FIX — Single-step plan produces a task that references non-existent dependencies

Step 2 (dependency inference) and Step 3 (preview table) are designed for multi-step plans. Nothing in the skill explicitly handles a one-step plan. The preview table template shows at minimum two rows. For a plan with one step, dependency inference is trivially "Independent," but the skill body as written does not say this — it describes a loop over steps without a base case. An agent could emit a preview table with one row (acceptable) or could skip the preview entirely (wrong — the user confirmation gate would be bypassed). No eval covers a single-step plan. Task 21's acceptance criteria do not mention this edge case.

### 3. MUST FIX — Coordinator auto-blocking issue not addressed

AGENTS.md documents the live coordinator: tasks transition from `todo → claimed → in_progress` automatically as the coordinator dispatches workers. The plan-to-tasks skill registers tasks one at a time (Step 4: "register immediately after each file, then continue to the next"). If the coordinator is running during a batch write, task N could be claimed and started by a worker before task N+1 (which depends on N) is even registered. This creates two problems: (a) task N+1 is registered after N is already in_progress, so the dependency link is set on a task whose predecessor is mid-flight; (b) if the coordinator attempts to dispatch N+1 before its `depends_on` field is populated, the dependency guard is never enforced. The skill contains no instruction to pause the coordinator, write all files first and register after, or use any other serialization mechanism. No backlog task (21–25) names this as a risk or an in-scope concern.

### 4. MUST FIX — Partial-batch failure leaves state inconsistent with no recovery path

Step 4 says "soft-fail with a warning, record the failure, continue." If registration fails for task N mid-batch, the markdown file exists on disk but is not in orchestrator state. The sync check at the end will surface the discrepancy, but the skill gives no actionable recovery instruction beyond "say: 'register <ref>'". If a worker subsequently runs (because the coordinator sees the file), it will be executing a task that has no registered entry — the worker's `run-start` call will fail. The Risk/Rollback section is absent from Task 21 (the skill-draft task), even though creating the skill file is a pure-code change with no stateful side effects — this is acceptable per TASK_TEMPLATE rules — but the batch-write failure mode is inherently a partial-state concern and deserves a Risk/Rollback entry on one of the tasks in scope (e.g. Task 23 where actual registration happens at scale).

### 5. MUST FIX — evals.json assertions are inconsistent with the actual evals.json file

Task 22 specifies: "Must not include assertions yet — those are added during the eval run in Task 23." However, the current `evals/evals.json` already contains a populated `expectations` array for all three evals. This means either Task 22 was not followed (assertions were pre-added during the skill draft) or Task 23's assertion-drafting step ran before the file was committed. Either way, there is a factual inconsistency: Task 22's acceptance criterion "No `assertions` field present" is already violated in the committed file. An agent running Task 23 would find assertions already present and either skip adding them (silently passing the criterion) or overwrite them. The eval schema field name used in evals.json is `expectations`; Task 22 refers to `assertions`; Task 23 refers to "assertions" in its goals but "expectations" in practice. This naming mismatch will cause confusion for the grading agent.

### 6. SHOULD FIX — Ambiguous step titles are not handled

SKILL.md does not address steps with identical or very similar titles (e.g. a plan where steps 2 and 3 are both titled "Write tests"). The slug-generation logic is implicit (inherited from create-task's kebab-case rule), but two identically-titled steps would produce colliding file names. The skill has no deduplication rule. A collision would silently overwrite the first file when the second is written. No eval covers this.

### 7. SHOULD FIX — User cancellation at the preview step is not handled

Step 3 says "Wait for confirmation before writing anything. If the user adjusts numbering, titles, or deps, update your plan accordingly." There is no instruction for what to do if the user says "cancel", "no", or "start over." An agent following the skill would likely stop or loop waiting for a valid confirmation, but the expected terminal behaviour (report nothing written, exit cleanly) is not specified. This is particularly important because the skill's description includes approval phrases like "looks good, go ahead" — a user who changes their mind and says "actually no" should get a clean exit, not a confused agent re-prompting.

### 8. SHOULD FIX — evals.json has no negative-trigger eval

All three evals are positive: the user intends to convert a plan into tasks. There is no eval for a near-miss trigger where the skill should NOT fire (e.g. "create a single task for the login flow" or "show me the current plan"). Without a negative eval, description optimization (Task 25) has no penalty signal for false positives. Task 25 generates 20 trigger-eval queries separately, but these are not connected to evals.json and will not be captured in the standard eval harness results.

### 9. SHOULD FIX — Task 25 dependency on Task 24 is declared but Task 24's output is not the prerequisite

Task 25 `depends_on` includes `general/24-plan-to-tasks-review-iterate`. But the actual prerequisite for description optimization is only that a stable version of `SKILL.md` exists — Task 21 (the draft). Task 24 iterates on the skill body, which is explicitly out of scope for Task 25. The dependency is defensible (you want iteration complete before locking the description), but the skill spec in Task 25 context section references only the skill-creator optimization script and makes no reference to Task 24 outputs. If Task 24 never runs (e.g. eval results were already satisfactory after Task 23), Task 25 is blocked on a task that may be skipped. The stated dependency forces a strictly sequential path that the task workflow does not require.

### 10. SHOULD FIX — Task 23's Implementation step references a hardcoded plugin path

The aggregation and viewer commands in Task 23 hardcode `~/.claude/plugins/cache/claude-plugins-official/skill-creator/90accf6fd200/skills/skill-creator`. This path embeds a content-addressable hash (`90accf6fd200`) that will silently break if the skill-creator plugin is updated. A worker agent running Task 23 in the future will fail with a path-not-found error with no guidance on how to resolve it. The Verification section of Task 23 does not include a check that the skill-creator path exists before running.

### 11. SHOULD FIX — Task 24 acceptance criteria are not fully binary/verifiable

Task 24 has: "SKILL.md changes are generalisations, not narrow patches." This is a subjective quality judgment, not a binary observable criterion. An automated agent or reviewer cannot pass/fail this without human interpretation. The AGENTS.md quality standard for acceptance criteria is "binary checklist; at least one failure/edge-case item." Task 24 also has: "Final state: user confirms satisfaction or all feedback fields are empty" — the disjunction makes this non-deterministically verifiable in an automated context.

### 12. MINOR — Task 22 acceptance criterion references the wrong field name

Task 22's acceptance criterion is: "No `assertions` field present — that is added in Task 23." The actual field name used in evals.json is `expectations`, not `assertions`. Both the criterion and Task 23's goals use "assertions" inconsistently with the file's actual schema key. This does not affect correctness but will confuse any agent verifying against the criterion.

### 13. MINOR — SKILL.md Step 1 has no fallback for MCP unavailability in batch context

The shell fallback for `next_task_seq` is: `ls backlog/ | grep -oE '^[0-9]+' | sort -n | tail -1 | xargs -I{} expr {} + 1`. This is correct for a single invocation, but in a batch where files are being written mid-loop, the filesystem listing will advance after each file is created. If the agent recalculates `next_task_seq` mid-batch (e.g. after a MCP failure recovery), it would produce correct numbers. However, the skill only says to get the number once in Step 1 and assign sequential numbers from there. This is fine as long as no other process writes to backlog/ concurrently — but there is no instruction to guard against concurrent writes or check for number collisions before writing each file.

### 14. MINOR — create-task's `## Tests` section requirement is not enforced for non-code tasks

The create-task quality gate requires a `## Tests` section. Plan-to-tasks produces tasks for arbitrary plan steps — many of which may be skill files, documentation, or eval runs (like tasks 22–25 themselves) where a `## Tests` section is vacuous. SKILL.md Step 4 says "Everything else ... comes from create-task unchanged," which would mandate a `## Tests` section even for tasks with no testable code. Task 21 itself omits the `## Tests` section (acceptable per create-task rules only when no code is involved, but create-task's quality gate table lists it unconditionally). The skill gives no guidance on when `## Tests` may be omitted for generated tasks.

---

## Summary

| # | Severity | Area |
|---|----------|------|
| 1 | MUST FIX | No-plan edge case under-specified; no eval coverage |
| 2 | MUST FIX | Single-step plan base case missing |
| 3 | MUST FIX | Coordinator auto-blocking not addressed |
| 4 | MUST FIX | Partial-batch failure leaves inconsistent state; no recovery path |
| 5 | MUST FIX | evals.json field naming mismatch + task 22 criterion already violated |
| 6 | SHOULD FIX | Ambiguous/duplicate step titles not handled |
| 7 | SHOULD FIX | User cancellation at preview not handled |
| 8 | SHOULD FIX | No negative-trigger eval in evals.json |
| 9 | SHOULD FIX | Task 25 dependency on Task 24 is over-constrained |
| 10 | SHOULD FIX | Hardcoded plugin path with content-hash in Task 23 |
| 11 | SHOULD FIX | Task 24 acceptance criteria not fully binary |
| 12 | MINOR | Field name "assertions" vs "expectations" inconsistency in Task 22 |
| 13 | MINOR | No guard against concurrent backlog writes during batch |
| 14 | MINOR | Tests section requirement for non-code generated tasks unaddressed |

**Verdict: NEEDS CHANGES**
