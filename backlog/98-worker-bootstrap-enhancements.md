---
ref: publish/98-worker-bootstrap-enhancements
feature: publish
priority: high
status: todo
---

# Task 98 — Enhance Worker Bootstrap Template for Consumer Readiness

Independent.

## Scope

**In scope:**
- Replace manual frontmatter editing with `orc task-mark-done` in the worker workflow
- Adopt structured review protocol (`review-submit`, `review-read`, `REVIEW_FINDINGS` block)
- Add `orc progress --event=phase_started` calls at all 5 phase boundaries
- Add `npm test` gate between implement and review phases
- Add "WHAT TO AVOID" guardrails section
- Add verification checklist before `run-work-complete`
- Enhance interactive prompt rule with specific blocker categories
- Enhance commit discipline with `fix()`/`chore()` variants and `--no-verify` prohibition

**Out of scope:**
- Changing any runtime code (lib/, cli/, coordinator.ts)
- Modifying master bootstrap templates (separate task)
- Modifying scout bootstrap templates
- Changing the task-envelope or scout-brief templates
- Updating AGENTS.md (it will be deferred to a later migration task)

---

## Context

The worker bootstrap template (`templates/worker-bootstrap-v2.txt`) is the **only** instruction set that consumer workers will see when orc-state is installed as an npm package. AGENTS.md won't exist in consumer repos. An audit found 6 critical divergences between the bootstrap and AGENTS.md, plus missing guardrails that AGENTS.md provides.

### Current state

- Step 6 manually edits frontmatter (`status: todo -> status: done`) and commits — can leave runtime state out of sync
- Review protocol uses inline REVIEWER CONSTRAINTS with direct output consolidation — doesn't use `orc review-submit`/`orc review-read` or the structured `REVIEW_FINDINGS` block
- No `orc progress` phase signals emitted — coordinator has zero phase visibility
- No test gate — workers can proceed to review with broken tests
- No "What to Avoid" guardrails — common failure modes (scope creep, unnecessary deps) unguarded
- No verification checklist before completion
- Interactive prompt rule doesn't distinguish tool permission prompts from genuine blockers

### Desired state

- Workers use `orc task-mark-done` for atomic spec+state updates
- Review protocol uses `review-submit`/`review-read` with grep-able `REVIEW_FINDINGS` blocks
- All 5 phases emit `orc progress --event=phase_started`
- `npm test` must pass before entering review phase
- "WHAT TO AVOID" section prevents common worker failure modes
- Verification checklist gates `run-work-complete`
- Interactive prompt rule specifies exactly when to use `run-input-request`
- Commit discipline covers `fix()`/`chore()` prefixes and `--no-verify` prohibition

### Start here

- `templates/worker-bootstrap-v2.txt` — the only file to modify
- `AGENTS.md` — reference for the correct protocols (lines 89-124 for review, 60-158 for phases, 385-439 for discipline/avoidance)

**Affected files:**
- `templates/worker-bootstrap-v2.txt` — all changes in this single file

---

## Goals

1. Must replace manual frontmatter editing with `{{orc_bin}} task-mark-done <task-ref>`.
2. Must adopt the `review-submit` / `review-read` / `REVIEW_FINDINGS` protocol for sub-agent reviews.
3. Must emit `orc progress --event=phase_started --phase=<name>` at all 5 phase boundaries (explore, implement, review, complete, finalize).
4. Must gate the review phase on `npm test` exiting 0.
5. Must include a "WHAT TO AVOID" section with at least 6 anti-patterns.
6. Must include a verification checklist before `run-work-complete`.
7. Must specify that tool permission prompts resolve automatically and list exactly 3 legitimate blocker categories for `run-input-request`.

---

## Implementation

### Step 1 — Replace manual frontmatter editing

**File:** `templates/worker-bootstrap-v2.txt`

Replace lines 71-75 (step 6):

```
  6. Commit your changes:
       Edit backlog/<N>-<slug>.md for this task.
       Change the frontmatter line: status: todo -> status: done
       git add -p
       git commit -m "feat(<scope>): <outcome>"
```

With:

```
  6. Commit your changes:
       git add -p
       git commit -m "feat(<scope>): <outcome>"
     Valid commit prefixes: feat(<scope>), fix(<scope>), chore(<scope>).
     Never use --no-verify or skip pre-commit hooks.
  7. Mark the task done (updates spec frontmatter + runtime state atomically):
       {{orc_bin}} task-mark-done <task-ref>
```

Renumber all subsequent steps (+1).

### Step 2 — Add phase signals

**File:** `templates/worker-bootstrap-v2.txt`

Insert `orc progress` calls at each phase boundary in the WORKTREE RULE workflow:

- Before step 4 (reading spec): `{{orc_bin}} progress --event=phase_started --phase=explore --run-id=<run_id> --agent-id={{agent_id}}`
- Before step 5 (writing code): `{{orc_bin}} progress --event=phase_started --phase=implement --run-id=<run_id> --agent-id={{agent_id}}`
- Before step 6 (commit+review): `{{orc_bin}} progress --event=phase_started --phase=review --run-id=<run_id> --agent-id={{agent_id}}`
- Before step 7/task-mark-done: `{{orc_bin}} progress --event=phase_started --phase=complete --run-id=<run_id> --agent-id={{agent_id}}`
- Before step 10 (waiting for coordinator): `{{orc_bin}} progress --event=phase_started --phase=finalize --run-id=<run_id> --agent-id={{agent_id}}`

### Step 3 — Add test gate

**File:** `templates/worker-bootstrap-v2.txt`

Insert between implementation work (step 5) and the review phase signal:

```
  Gate: run `npm test`. It MUST exit 0. Do NOT proceed to the review phase with failing tests.
```

### Step 4 — Adopt structured review protocol

**File:** `templates/worker-bootstrap-v2.txt`

Replace the current sub-agent review round (step 7 area). New protocol:

1. Emit heartbeat before spawning reviewers
2. Instruct each reviewer to call:
   ```
   {{orc_bin}} review-submit --run-id=<run_id> --agent-id=<their_agent_id> \
     --outcome=<approved|findings> --reason="<findings text>"
   ```
3. Instruct reviewers to wrap output in:
   ```
   REVIEW_FINDINGS
   verdict: approved | findings

   <one finding per issue, or "No issues found.">
   REVIEW_FINDINGS_END
   ```
4. Keep REVIEWER CONSTRAINTS block but add `review-submit` as the only allowed orc command
5. Worker retrieves findings via `{{orc_bin}} review-read --run-id=<run_id>`
6. If a reviewer failed or is non-responsive, proceed with reviews that were submitted
7. Parse `review-read` output — all submitted reviewers must report `approved`
8. One review round only — address findings in a fixup commit

### Step 5 — Add verification checklist

**File:** `templates/worker-bootstrap-v2.txt`

Insert before the `run-work-complete` step:

```
  Before calling run-work-complete, verify:
    - npm test passes
    - New pure logic has tests
    - No files modified outside the stated task scope
```

### Step 6 — Add "WHAT TO AVOID" section

**File:** `templates/worker-bootstrap-v2.txt`

Add new section before the existing RULES section:

```
WHAT TO AVOID

- Adding npm dependencies without asking first (use run-input-request).
- Calling internal library functions (withLock, atomicWriteJson, appendSequencedEvent)
  directly — use orc CLI commands instead.
- Writing inline Node.js scripts to manipulate state files — use orc CLI commands.
- Refactoring, renaming, or "improving" code beyond what the task requires.
- Adding features, abstractions, or error handling for hypothetical future cases.
- Leaving tests broken.
- Using --no-verify or skipping pre-commit hooks.
```

### Step 7 — Enhance interactive prompt rule

**File:** `templates/worker-bootstrap-v2.txt`

Update the INTERACTIVE PROMPT RULE section. Add before the existing content:

```
Tool permission prompts (e.g. CLI tool asking for approval) should resolve
automatically through your local tool permission handling. Do NOT call
run-input-request for these.

Call run-input-request ONLY when blocked on:
- Ambiguous or missing spec requirements that block implementation.
- Merge conflicts that are genuinely unresolvable without human input.
- External dependencies that are unavailable (service down, credential missing).
```

Keep the existing example but reframe it for the three categories above.

---

## Acceptance criteria

- [ ] `orc task-mark-done` replaces manual frontmatter editing in the workflow.
- [ ] Commit step includes `fix()`/`chore()` variants and `--no-verify` prohibition.
- [ ] All 5 `orc progress --event=phase_started` calls present (explore, implement, review, complete, finalize).
- [ ] `npm test` gate exists between implement and review phases.
- [ ] Review protocol uses `review-submit` + `review-read` + `REVIEW_FINDINGS` block.
- [ ] REVIEWER CONSTRAINTS block updated to allow `review-submit` as the only orc command.
- [ ] Verification checklist present before `run-work-complete`.
- [ ] "WHAT TO AVOID" section present with at least 6 anti-patterns.
- [ ] Interactive prompt rule specifies tool permissions resolve automatically.
- [ ] Interactive prompt rule lists exactly 3 legitimate blocker categories.
- [ ] All template variable references (`{{orc_bin}}`, `{{agent_id}}`) are consistent and correctly placed.
- [ ] `npm test` passes.
- [ ] No changes to files outside `templates/worker-bootstrap-v2.txt`.

---

## Tests

No new unit tests required. The bootstrap template is a text file — validation is via content inspection and existing `lib/sessionBootstrap.test.ts` passing.

---

## Verification

```bash
# Verify template renders without errors
node -e "import('./lib/sessionBootstrap.ts').then(m => { const b = m.getWorkerBootstrap('claude', 'test-1', '/usr/bin/orc', 'tok-123'); console.log('OK:', b.substring(0, 50)); })"

# Verify phase signals present
grep -c 'phase_started' templates/worker-bootstrap-v2.txt
# Expected: 5

# Verify review-submit/review-read present
grep 'review-submit\|review-read' templates/worker-bootstrap-v2.txt

# Verify task-mark-done present, manual frontmatter edit removed
grep 'task-mark-done' templates/worker-bootstrap-v2.txt
grep -c 'status: todo -> status: done' templates/worker-bootstrap-v2.txt
# Expected: 0

# Full suite
nvm use 24 && npm test
```
