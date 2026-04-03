---
ref: publish/116-deterministic-sub-agent-reviews
feature: publish
priority: normal
status: done
---

# Task 116 — Deterministic Sub-Agent Review Output

Independent.

## Scope

**In scope:**
- Restructure worker bootstrap review instructions to inline diff context (not let reviewers explore)
- Move output format instructions to end of reviewer constraint block (recency bias)
- Add retry-on-missing-block logic to worker bootstrap review read step

**Out of scope:**
- Changes to `orc review-submit` or `orc review-read` CLI commands
- Changes to the review event schema or SQLite storage
- Adding programmatic output validation (API-level prefill, structured output)
- Changes to coordinator, MCP handlers, or state files

---

## Context

### Current state

Workers spawn sub-agent reviewers (critic, integrator) during Phase 3 by passing them
acceptance criteria and asking them to run `git diff`. The reviewer agent definitions
(`agents/critic.md`, `agents/integrator.md`) include the `REVIEW_FINDINGS` output format
at the end, but the worker bootstrap's REVIEWER CONSTRAINTS block puts format instructions
in the middle (lines 100-105), sandwiched between the `review-submit` command and the
deny-list of forbidden commands.

Reviewers are free to explore the codebase (Read, Grep, Glob, Bash tools), which inflates
their context window. By the time they finish investigating, the formatting instructions
from early in the prompt have lost salience. This leads to non-deterministic output:
reviewers sometimes return partial or unstructured findings.

### Desired state

1. Worker bootstrap tells reviewers to review the inlined diff — not to explore freely.
   The diff is already captured by the worker before spawning reviewers.
2. The `REVIEW_FINDINGS` format block is the last thing in the REVIEWER CONSTRAINTS,
   immediately before `--- END REVIEWER CONSTRAINTS ---`, maximizing recency.
3. After `review-read`, the worker checks for `REVIEW_FINDINGS_END` in each reviewer's
   output. If missing from a reviewer that did submit via `review-submit`, the worker
   sends a single retry message asking only for the structured block.

### Start here

- `templates/worker-bootstrap-v2.txt` — lines 80-122, the review round instructions
- `agents/critic.md` — reviewer agent definition with output format
- `agents/integrator.md` — reviewer agent definition with output format

**Affected files:**
- `templates/worker-bootstrap-v2.txt` — primary change: restructure review instructions
- `agents/critic.md` — reinforce diff-only review, no free exploration
- `agents/integrator.md` — reinforce diff-only review, no free exploration
- `AGENTS.md` — update Phase 3 instructions to match new review protocol

---

## Goals

1. Must restructure REVIEWER CONSTRAINTS to tell reviewers the diff is inlined — they should not explore the codebase independently.
2. Must move the REVIEW_FINDINGS format block to be the last section in REVIEWER CONSTRAINTS (before END marker).
3. Must add a retry step in the worker bootstrap: after `review-read`, if a reviewer submitted findings via `review-submit` but the text output lacks `REVIEW_FINDINGS_END`, send one follow-up message requesting only the formatted block.
4. Must update `agents/critic.md` and `agents/integrator.md` to reinforce that they review only the provided diff, not explore freely.
5. Must update `AGENTS.md` Phase 3 to reflect the new review protocol.
6. Must not change any runtime code (CLI commands, handlers, coordinator, state files).

---

## Implementation

### Step 1 — Restructure REVIEWER CONSTRAINTS in worker bootstrap

**File:** `templates/worker-bootstrap-v2.txt`

Reorder the REVIEWER CONSTRAINTS block (lines 90-115) so that:
1. First: role statement + "review the diff provided above, do not explore"
2. Middle: `review-submit` command requirement + deny-list
3. Last: `REVIEW_FINDINGS` output format requirement

Also update step 7b to explicitly say "Give each the full diff output (not just file names)".

### Step 2 — Add retry step to worker bootstrap

**File:** `templates/worker-bootstrap-v2.txt`

After step 7c (retrieve findings), add a new sub-step:
- For each reviewer that submitted via `review-submit` but whose text output
  lacks `REVIEW_FINDINGS_END`, send one follow-up message:
  "Your review-submit was received but the structured REVIEW_FINDINGS block
   is missing from your output. Emit only the block now."
- If the retry also fails, treat as non-responsive (existing behavior).

### Step 3 — Update critic agent definition

**File:** `agents/critic.md`

In the "How to review" section, change step 1 from inspecting via `git diff`
to reviewing the diff provided in the spawn prompt. Add explicit instruction:
"Do not explore the codebase beyond the provided diff and task spec."

### Step 4 — Update integrator agent definition

**File:** `agents/integrator.md`

Same changes as Step 3.

### Step 5 — Update AGENTS.md Phase 3

**File:** `AGENTS.md`

Update Phase 3 review instructions to reflect:
- Diff is inlined in reviewer prompt
- Format block is last in constraints
- One retry for missing structured output

---

## Acceptance criteria

- [ ] REVIEWER CONSTRAINTS block in `worker-bootstrap-v2.txt` has output format as last section
- [ ] REVIEWER CONSTRAINTS tells reviewers to use the inlined diff, not explore independently
- [ ] Worker bootstrap includes a retry sub-step for missing `REVIEW_FINDINGS_END`
- [ ] `agents/critic.md` instructs reviewing provided diff only
- [ ] `agents/integrator.md` instructs reviewing provided diff only
- [ ] `AGENTS.md` Phase 3 reflects updated protocol
- [ ] No changes to runtime code (CLI, handlers, coordinator, state files)
- [ ] No changes to files outside the stated scope

---

## Tests

No runtime code changes — no new tests required.
Verification is by inspection of template and doc changes.

---

## Verification

```bash
# Verify no runtime code was modified
git diff --name-only main | grep -v -E '(templates/|agents/|AGENTS\.md|backlog/)' && echo "FAIL: unexpected files changed" || echo "OK: only docs/templates changed"
```

```bash
# Verify REVIEW_FINDINGS format is last in constraints block
grep -n "REVIEW_FINDINGS\|END REVIEWER CONSTRAINTS" templates/worker-bootstrap-v2.txt
```

```bash
# Final required repo-wide checks
nvm use 24 && npm test
```
