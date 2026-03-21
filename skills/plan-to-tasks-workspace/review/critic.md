# Critic Review — plan-to-tasks Skill and Backlog Tasks

Reviewed files:
- `skills/plan-to-tasks/SKILL.md`
- `skills/plan-to-tasks/evals/evals.json`
- `backlog/21-plan-to-tasks-skill-draft.md`
- `backlog/22-plan-to-tasks-test-prompts.md`
- `backlog/23-plan-to-tasks-run-evals.md`
- `backlog/24-plan-to-tasks-review-iterate.md`
- `backlog/25-plan-to-tasks-optimize-description.md`

Context files: `skills/create-task/SKILL.md`, `backlog/TASK_TEMPLATE.md`

---

## Findings

### SKILL.md

**1. MUST FIX — Description triggers overlap with `create-task` skill**

The `create-task` description includes "Also handles batch planning (multiple dependent tasks from a single request)" and triggers on "add to backlog", "create tasks to backlog", and similar phrases. The `plan-to-tasks` description triggers on "add them to the backlog" and "make the tasks". These phrases are near-identical to `create-task` triggers.

When a user says "add them to the backlog" after seeing a plan, the routing between the two skills is ambiguous. Both could plausibly fire. The `plan-to-tasks` description relies on the qualifier "aimed at an existing printed plan" — but that is a contextual inference, not a lexical distinction. An agent with both skills loaded may route to `create-task` instead. The current description needs a sharper boundary that cannot be confused with `create-task`'s batch workflow trigger.

---

**2. MUST FIX — "read create-task SKILL.md now" is an instruction that cannot be reliably obeyed**

Step 4 says: "run the full create-task workflow (from `skills/create-task/SKILL.md`)". The skill instructs the agent to read a second skill file and hold it in context. However, the skill does not include an explicit instruction for *how* to read it — no `Read` tool call, no MCP resource URI, no path relative to repo root.

More critically, Step 0 of the intro says "read `skills/create-task/SKILL.md` now and keep it in context for the task-writing steps below." This is the right intent, but the instruction placement is wrong. An agent that encounters this skill may have already committed to a plan by the time it reads Step 0. The read-now instruction should be the first action, before any other steps.

---

**3. MUST FIX — Step 4 says "run the full create-task workflow" but omits which parts to skip**

The text says "Everything else... comes from create-task unchanged." But `create-task` includes: Step 0 (orient, next task number), Step 0.5 (feature resolution), the quality gate, the "Register in backlog.json" step, and the Output Contract. Plan-to-tasks says "already done above, skip re-asking" for Step 0.5. However, it does not clearly address:

- Should the agent run the `create-task` **quality gate** for each task? (Probably yes, but it is never stated.)
- Should the `create-task` **Output Contract** be applied per-task or once at the end? The plan-to-tasks skill has its own final report in Step 5 — but the create-task Output Contract says to list every task and ref in the final response. An agent following both literally would produce a redundant dual report.
- `create-task` section order requires `## Tests` as section 8 — but the task specs produced in backlog/21–25 do not follow this, using headings like `## Acceptance criteria` without a separate `## Tests` section. This inconsistency will confuse an agent trying to apply create-task rules to plan-to-tasks output.

---

**4. SHOULD FIX — Step 1 shell fallback is fragile and misleading**

The shell fallback for getting the next task number is:
```
ls backlog/ | grep -oE '^[0-9]+' | sort -n | tail -1 | xargs -I{} expr {} + 1
```
`ls` output is not guaranteed to be sorted by name in all environments, and the pipe does not account for non-numeric filenames at the start (e.g. `TASK_TEMPLATE.md` would produce no match and be silently ignored, which is correct — but the fallback has no error handling if `backlog/` is empty). More importantly, the AGENTS.md explicitly discourages using `grep` and `ls` directly; the agent should prefer MCP. The fallback should at minimum note it is only for MCP failure, not an alternative path.

---

**5. SHOULD FIX — No instruction for what to do if `$ARGUMENTS` is blank**

The frontmatter defines `argument-hint: "[optional: override feature name]"`. The body begins with `$ARGUMENTS`. When no argument is provided (the common case), `$ARGUMENTS` expands to nothing. There is no instruction telling the agent to ignore the blank `$ARGUMENTS` and proceed — an agent that is literal may interpret the blank as a missing required argument or stall. The skill should explicitly state: "If `$ARGUMENTS` is blank, no feature override was given — resolve feature via Step 1.2."

---

**6. SHOULD FIX — Step 2 dependency inference examples are circular with the plan itself**

The dependency guidance says:
> "Sequential order alone is not a dependency. Two steps that work on independent concerns can be executed in any order — default to Independent unless there is a real logical reason to serialize."

This is correct principle. However, the skill provides no guidance on how to handle the case where a plan is explicitly sequential (Step 1 → Step 2 → Step 3 → ...) but each step has no logical data dependency. Many real plans are ordered as conventions or workflow steps, not code dependencies. The agent will frequently over-infer or under-infer here. The guidance needs at least one concrete example of an apparently-sequential plan where most steps are actually Independent.

---

**7. SHOULD FIX — Preview table format in Step 3 does not match frontmatter `ref` conventions**

The example preview table shows:
```
  21   21-write-skill-draft        Write the skill draft           Independent
```

But the `ref` field in frontmatter follows `<feature>/<slug>` format (e.g., `general/21-plan-to-tasks-skill-draft`). The preview table shows bare slugs without the feature prefix, which means the preview and the eventual frontmatter ref will look different. An agent comparing the preview to the output may be confused. The preview table should show the full `ref` column, or the skill should explicitly note that the preview uses abbreviated slugs.

---

**8. SHOULD FIX — Step 4 "Batch mode" soft-fail instruction is ambiguous about state**

"Do not stop the batch on a single registration failure (soft-fail with a warning, record the failure, continue)" — but the skill does not say where to "record the failure." The `create-task` skill has a specific warning block format. Does the agent use that? Write to a file? Just track it in memory? Without a concrete recording mechanism, the agent may simply continue and forget the failure, causing the final Step 5 report to miss it.

---

**9. MINOR — Step 0 fallback "ask the user to paste or restate it" is underspecified**

If no numbered plan is visible, the agent is told to "ask the user to paste or restate it." But the skill does not specify what response format or signal would satisfy this condition — i.e., what counts as "a plan" once the user provides one. A one-sentence description? A bulleted list? An agent may accept almost anything and try to parse it, defeating the purpose of requiring a prior printed plan.

---

**10. MINOR — `$ARGUMENTS` substitution is not explained for agents unfamiliar with skill conventions**

The template substitution token `$ARGUMENTS` is used here without explanation. An agent that has not seen skill conventions before will not know this is replaced by whatever text follows the skill invocation command. While this is a framework convention issue, a comment like `<!-- $ARGUMENTS: replaced with the optional feature-override text, if any -->` would prevent confusion.

---

### evals/evals.json

**11. MUST FIX — Evals contain assertions but Task 22 spec says assertions must not be present**

Task 22's acceptance criteria explicitly states: "No `assertions` field present — that is added in Task 23." However, the current `evals.json` contains a fully populated `expectations` array for all three evals. The field name is `expectations` (not `assertions`), but the semantic intent is identical to what the task says should not be present yet. If `expectations` and `assertions` are the same concept under different keys, this is a naming inconsistency between the task spec and the actual schema. If they are different concepts, the distinction is never explained.

---

**12. SHOULD FIX — Eval 1 context is missing: the skill cannot be evaluated without a prior plan in the conversation**

Eval 1 prompt is "ok create the tasks". The `files` array is empty and there is no `conversation_context` field. This prompt is completely ambiguous without a preceding plan in the conversation. A standalone eval runner executing this prompt has no plan to work from. The eval would either fail (no plan found) or hallucinate a plan. The eval needs either a `conversation_context` field with a sample numbered plan, or the schema must explicitly support injecting prior turns.

The same issue applies to all three evals — none provide a plan for the agent to read.

---

**13. SHOULD FIX — Eval 3's "steps 2 and 3 can run in parallel" constraint is tested, but the plan has 5 steps whose identity is undefined**

The `expected_output` for eval 3 says "Exactly 5 task specs are produced, one per plan step" and "Step 4 depends on Step 1 (build job needs the CI yaml from Step 1)". These expectations presuppose a specific 5-step CI/CD plan that is not visible in the eval. Without a `conversation_context` field containing this plan, a grader cannot verify the expectations because the ground truth plan is unknown. The eval is internally consistent (it references step numbers and domains like "CI yaml", "deploy") but will be unrunnable without the corresponding conversation fixture.

---

**14. MINOR — `files` field is empty for all evals, which may be correct, but is never explained**

All three evals have `"files": []`. If this field is meant to carry file fixtures to write before running the eval (i.e., pre-conditions), the emptiness is correct for a skill that only needs conversation context. But if the skill-creator eval harness requires a populated `files` array to specify initial repository state, all three evals are missing it. The task spec does not clarify what `files` is for.

---

### Backlog Task Specs (21–25)

**15. MUST FIX — Tasks 21–25 do not follow the `TASK_TEMPLATE.md` section order required by `create-task`**

`create-task/SKILL.md` Output Contract specifies section order:
1. Title
2. Dependency line
3. Scope
4. Context
5. Goals
6. Implementation
7. Acceptance criteria
8. **Tests** ← required section
9. Verification

Tasks 21–25 all lack a `## Tests` section. They jump from `## Acceptance criteria` directly to `## Verification`. This is inconsistent with the template the skill is supposed to enforce. For a skill whose purpose is to demonstrate how `create-task` standards are applied, the output tasks should be exemplary conformance with those standards.

---

**16. SHOULD FIX — Tasks 21–25 Context sections are missing the required subsections from TASK_TEMPLATE.md**

`TASK_TEMPLATE.md` defines three required subsections within `## Context`:
- `### Current state`
- `### Desired state`
- `### Start here`

And a required `**Affected files:**` block. Tasks 21–25 omit `### Current state`, `### Desired state`, and `### Start here` subsections entirely. The `**Affected files:**` block is present in tasks 21–22 but absent in tasks 23–25. An agent following TASK_TEMPLATE.md would produce these sections; tasks created by this skill should model the correct format.

---

**17. SHOULD FIX — Task 22 Goal 4 says "Must not include assertions yet" but the produced evals.json has assertions**

Task 22's goal 4 states: "Must not include assertions yet — those are added during the eval run in Task 23." The delivered `evals.json` file has a populated `expectations` array for all three evals. Even if the field name differs from "assertions," this violates the stated goal. Either the goal was wrong (assertions were correctly added during task 22 rather than 23), or the acceptance criterion was not enforced. Either way, there is a mismatch between the spec and the artifact.

---

**18. SHOULD FIX — Task 23 implementation is under-specified for the actual skill-creator eval toolchain**

Task 23 steps reference:
```bash
python -m scripts.aggregate_benchmark skills/plan-to-tasks-workspace/iteration-1 \
  --skill-name plan-to-tasks
```
and a `python <skill-creator-path>/eval-viewer/generate_review.py` command. These are referenced as if they are known, stable scripts. However, Task 23's Context says the workflow lives at a cached plugin path (`~/.claude/plugins/cache/.../skill-creator/`). An agent in a fresh environment may not have this path, or it may have a different hash. The task should either (a) verify the path exists before using it, or (b) provide a fallback instruction if the path is not found.

---

**19. SHOULD FIX — Task 24's iteration termination condition is vague**

"Continue until the user confirms they are satisfied" is the only stopping criterion. There is no timeout, no maximum iteration count, and no definition of what "confirmed" looks like (a specific message? any positive response?). For an autonomous agent, this is an open-ended loop with no deterministic exit. Task 24 should define: maximum N iterations before surfacing to operator, or a concrete signal pattern that counts as "satisfied."

---

**20. SHOULD FIX — Task 25 implementation Step 2 says "Open the eval review HTML using the skill-creator template" with no concrete path or command**

Step 2 says to "Open the eval review HTML using the skill-creator template and wait for the user to confirm or adjust queries." This is the only step in the task without a concrete command or file path. The implementation is otherwise very specific (exact bash commands, model name, flags). Step 2 needs either a concrete command to generate/open the HTML or an explicit alternative (e.g., "print the queries inline and wait for user confirmation").

---

**21. MINOR — Task 23 Verification runs `npm test` but the task produces no TypeScript or JavaScript**

The verification block ends with `nvm use 24 && npm test`. Task 23 only produces JSON files and eval run artifacts. There is no code under test that `npm test` would exercise. Running `npm test` here is a habit-copy from the template and not meaningful. While not harmful, it is misleading — a failing unrelated test could cause this task to appear incomplete.

---

**22. MINOR — Task 25 model name `claude-sonnet-4-6` in the run_loop.py command is hardcoded**

The `--model claude-sonnet-4-6` flag hardcodes a specific model version in the implementation step. If the optimization is run against a different model deployment, the command will be wrong. This should be noted as the current default with a comment to verify against available models, or it should be parameterized.

---

## Summary

Critical gaps:
- The `plan-to-tasks` description risks routing conflicts with `create-task` (finding 1).
- The skill's instruction to "read create-task SKILL.md now" lacks a concrete read action and is placed after other context (finding 2).
- The relationship between create-task and plan-to-tasks sections to skip vs. inherit is ambiguous, especially the Output Contract and quality gate (finding 3).
- The evals are missing conversation context fixtures, making them unrunnable as standalone eval inputs (findings 12, 13).
- The produced backlog tasks 21–25 deviate from the TASK_TEMPLATE.md section order they are meant to exemplify (findings 15, 16).

---

**VERDICT: NEEDS CHANGES**
