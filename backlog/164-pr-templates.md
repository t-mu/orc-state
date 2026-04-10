---
ref: general/164-pr-templates
feature: general
priority: high
status: todo
review_level: light
---

# Task 164 — Create PR and Reviewer Templates

Independent.

## Scope

**In scope:**
- Create `templates/pr-template-v1.txt` — PR body template
- Create `templates/pr-review-envelope-v1.txt` — reviewer worker payload
- Create `templates/pr-reviewer-bootstrap-v1.txt` — reviewer worker bootstrap

**Out of scope:**
- Coordinator logic that renders these templates (Task 165)
- Git host adapter (Task 162)
- PR CLI commands (Task 163)
- Worker bootstrap changes (Task 166)

---

## Context

The PR merge strategy requires three new templates:

1. **PR body** — rendered by the coordinator when creating the PR. Contains task ref,
   acceptance criteria, review level, and context. The PR reviewer reads this to
   understand what to review.

2. **PR review envelope** — sent to the reviewer worker after bootstrap. Contains
   pr_ref, run_id, task_ref, review_level, worktree path. Analogous to TASK_START
   for regular workers.

3. **PR reviewer bootstrap** — the reviewer worker's instructions. A deterministic
   7-step protocol: report for duty → setup → initial rebase → review-fix loop →
   pre-push rebase → CI loop → merge. Uses `orc pr-*` commands only (never
   platform CLIs). Spawns sub-agent reviewers per `review_level`. Hard iteration
   limits prevent infinite loops.

**Start here:** `templates/worker-bootstrap-v2.txt` (existing bootstrap pattern to follow)

**Affected files:**
- `templates/pr-template-v1.txt` — new
- `templates/pr-review-envelope-v1.txt` — new
- `templates/pr-reviewer-bootstrap-v1.txt` — new

---

## Goals

1. Must provide a PR body template with task ref, acceptance criteria, review level, and context.
2. Must provide a PR review envelope with pr_ref, run_id, task_ref, review_level, worktree, orc_bin.
3. Must provide a reviewer bootstrap with deterministic 7-step protocol.
4. Must use `orc pr-*` commands — never `gh`, `glab`, or any platform CLI.
5. Must include explicit iteration limits (3 review-fix, 3 CI-fix).
6. Must include the REVIEWER CONSTRAINTS block for sub-agent spawning.
7. Must include two rebase points (initial + pre-push).
8. Must include `npm test` after pre-push rebase.

---

## Implementation

### Step 1 — PR body template

**File:** `templates/pr-template-v1.txt`

```
## Task
ref: {{task_ref}}
run_id: {{run_id}}

## Review level
{{review_level}}

## Acceptance criteria
{{acceptance_criteria}}

## Context
Worker: {{agent_id}}
Branch: {{branch}}
```

### Step 2 — PR review envelope

**File:** `templates/pr-review-envelope-v1.txt`

```
PR_REVIEW
pr_ref: {{pr_ref}}
run_id: {{run_id}}
task_ref: {{task_ref}}
review_level: {{review_level}}
assigned_worktree: {{worktree_path}}
orc_bin: {{orc_bin}}
PR_REVIEW_END
```

### Step 3 — PR reviewer bootstrap

**File:** `templates/pr-reviewer-bootstrap-v1.txt`

~120 lines. Deterministic 7-step protocol:

**Step 1** — Report for duty: `{{orc_bin}} report-for-duty --agent-id={{agent_id}} --session-token={{session_token}}`

**Step 2** — Receive PR_REVIEW, extract fields, cd into worktree, run-start.

**Step 3** — Initial rebase: `git fetch origin main && git rebase origin/main`. Resolve conflicts iteratively. `run-fail` if unresolvable.

**Step 4** — Review-fix loop (max 3 iterations):
- Generate diff: `git diff main...HEAD`
- Spawn sub-agents per `review_level` (none/light/full) with REVIEWER CONSTRAINTS block
- Collect findings via `{{orc_bin}} review-read`
- If findings: fix, commit `fix(<scope>): address review findings (iteration N)`, loop
- If approved: exit loop
- If iteration > 3: `run-fail --reason="review-fix loop exceeded 3 iterations" --policy=requeue`

**Step 5** — Pre-push rebase: `git fetch origin main && git rebase origin/main`. Run `npm test`. If tests fail after rebase, route back to Step 4 (counts against iteration limit).

**Step 6** — CI loop (max 3 iterations):
- `git push --force-with-lease`
- Wait for CI: `{{orc_bin}} pr-status <pr_ref> --wait` (blocks until CI resolves)
- If passing: exit loop
- If failing: diagnose, fix, commit `fix(<scope>): resolve CI failure (iteration N)`, loop
- If iteration > 3: `run-fail --reason="ci-fix loop exceeded 3 iterations" --policy=requeue`

**Step 7** — Hand off to coordinator: `{{orc_bin}} run-work-complete --run-id=<run_id> --agent-id={{agent_id}}`. Wait for coordinator to merge the PR and signal `run-finish`.

Include: failure protocol, rules section, `PR_REVIEWER_BOOTSTRAP_END` marker.

---

## Acceptance criteria

- [ ] `pr-template-v1.txt` has placeholders for task_ref, run_id, review_level, acceptance_criteria, agent_id, branch.
- [ ] `pr-review-envelope-v1.txt` has placeholders for pr_ref, run_id, task_ref, review_level, worktree_path, orc_bin.
- [ ] `pr-reviewer-bootstrap-v1.txt` contains all 7 steps in numbered order.
- [ ] Step 3 and Step 5 both perform `git fetch origin main && git rebase origin/main`.
- [ ] Step 4 includes sub-agent spawning with review_level branching (none/light/full).
- [ ] Step 4 includes verbatim REVIEWER CONSTRAINTS block.
- [ ] Step 5 includes `npm test` after rebase.
- [ ] Step 6 uses `git push --force-with-lease` (not `--force`).
- [ ] Step 6 uses `orc pr-status --wait` (not `gh pr checks` or polling).
- [ ] All iteration limits are 3 with explicit `run-fail` on exceeded.
- [ ] No references to `gh`, `glab`, or any platform CLI in any template.
- [ ] No changes to files outside the stated scope.

---

## Tests

Not applicable — task output is template text files, not executable code.

Verify template variables:

```bash
grep -c '{{' templates/pr-template-v1.txt          # should match expected count
grep -c '{{' templates/pr-review-envelope-v1.txt   # should match expected count
grep -q 'orc pr-' templates/pr-reviewer-bootstrap-v1.txt && echo "OK"
grep -q 'gh ' templates/pr-reviewer-bootstrap-v1.txt && echo "FAIL: platform CLI reference" || echo "OK"
```

---

## Verification

```bash
nvm use 24 && npm test
```
