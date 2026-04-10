---
ref: general/166-pr-worker-protocol-docs
feature: general
priority: normal
status: todo
review_level: none
depends_on:
  - general/165-coordinator-pr-finalization
---

# Task 166 — Update Worker Protocol and Documentation for PR Mode

Depends on Task 165 (coordinator PR path).

## Scope

**In scope:**
- Update `templates/worker-bootstrap-v2.txt` Phase 4 and 5 for PR mode awareness
- Update `AGENTS.md` Phase 4, Phase 5, worktree section, lifecycle commands, task summary
- Update `docs/cli.md` with PR CLI commands section

**Out of scope:**
- Coordinator logic (Task 165)
- Templates for PR reviewer (Task 164)
- Schema or config (Task 161)

---

## Context

The worker protocol needs to acknowledge that Phase 4 (rebase) and Phase 5
(finalize) behave differently under PR mode. The worker itself doesn't change
behavior — the coordinator decides what happens after `run-work-complete`. But
the documentation should explain both paths so workers understand why their
session may end without a finalize rebase request.

**Start here:** `AGENTS.md` Phase 4 section (line ~130)

**Affected files:**
- `templates/worker-bootstrap-v2.txt` — Phase 4/5 conditional notes
- `AGENTS.md` — Phase 4, Phase 5, worktree cleanup, lifecycle commands, task summary
- `docs/cli.md` — add PR commands section

---

## Goals

1. Must explain PR mode behavior in Phase 4 (rebase is skipped — reviewer handles it).
2. Must explain PR mode behavior in Phase 5 (session ends after run-work-complete).
3. Must note in worktree cleanup section that direct merge flow applies to direct mode only.
4. Must update run-work-complete description to not assume rebase happened.
5. Must add PR CLI commands to `docs/cli.md`.

---

## Implementation

### Step 1 — Update AGENTS.md

**File:** `AGENTS.md`

Phase 4 (line ~134): Make rebase conditional:
```markdown
2. Rebase onto main (direct mode only): `git rebase main`
   In PR mode, skip rebase — the PR reviewer handles rebasing.
```

Phase 5 (line ~143): Add PR mode:
```markdown
In direct mode: wait for coordinator follow-up (finalize rebase request).
In PR mode: your session ends after run-work-complete. A separate PR reviewer
worker takes ownership of the branch — it reviews, fixes, rebases, and merges
the PR. No further action required from you.
```

Worktree cleanup section (line ~43): Add note that merge-from-main-checkout describes direct mode.

Run lifecycle commands (line ~223): Update `run-work-complete` description to "signal implementation and review are done" (remove "rebase").

Task execution summary (line ~370): Update Phase 4 and 5 descriptions.

### Step 2 — Update worker bootstrap

**File:** `templates/worker-bootstrap-v2.txt`

Same conditional notes as AGENTS.md in the Phase 4 and Phase 5 sections.

### Step 3 — Add PR commands to CLI docs

**File:** `docs/cli.md`

Add "Pull Request" section:

```markdown
## Pull Request

Commands for interacting with pull requests. Used by PR reviewer workers —
not for direct human use. Require `pr_provider` in config.

| Command | Description |
|---------|-------------|
| `pr-diff <pr_ref>` | Print PR diff to stdout. |
| `pr-review <pr_ref>` | Submit PR review (approve or request changes). |
| `pr-merge <pr_ref>` | Merge the PR. |
| `pr-status <pr_ref>` | Show PR status and CI state. |
```

---

## Acceptance criteria

- [ ] AGENTS.md Phase 4 rebase is marked as direct-mode only.
- [ ] AGENTS.md Phase 5 explains PR mode (session ends, reviewer takes over).
- [ ] AGENTS.md worktree cleanup notes it applies to direct mode.
- [ ] AGENTS.md run-work-complete description doesn't assume rebase.
- [ ] Worker bootstrap has matching conditional notes.
- [ ] `docs/cli.md` has PR commands section with all 4 commands.
- [ ] No code changes — documentation and templates only.
- [ ] No changes to files outside the stated scope.

---

## Tests

Not applicable — documentation and template text only.

---

## Verification

```bash
nvm use 24 && npm test
```
