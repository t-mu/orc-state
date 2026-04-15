---
ref: release-automation/175-filter-internal-workflow-commits-from-changelog
feature: release-automation
review_level: full
priority: normal
status: done
---

# Task 175 — Filter Internal Workflow Commits from Release Changelog

Independent.

## Scope

**In scope:**
- Tighten release-note commit selection in `scripts/release.sh` so internal workflow noise does not appear in generated changelog sections.
- Define and implement an explicit exclusion policy for non-user-facing commits such as `mark task done` and backlog-only bookkeeping commits.
- Add regression coverage for changelog commit filtering and category grouping.

**Out of scope:**
- Redesigning the changelog category format (`Added`, `Changed`, `Fixed`, `Other`).
- Reworking npm publish, pack/install smoke, or tag/push behavior outside the commit-selection path.
- Broad changelog curation or manual editorial workflows.

---

## Context

The current release script builds changelog sections directly from raw commit subjects since the last tag and filters out only `chore(release): ...`. That is too weak for this repository, where internal workflow commits such as `mark task done` and backlog bookkeeping can land on `main` and then appear in public release notes.

That behavior degrades changelog quality and makes the release output look unreliable. The fix is not to redesign release generation; it is to narrow the input set so only release-worthy commits are grouped into the existing sections.

This task should keep the change focused: one explicit filtering path, clear exclusions, and regression tests that pin the intended behavior.

**Start here:**
- `scripts/release.sh` — current changelog generation and commit filtering
- `CHANGELOG.md` — current output shape and heading format
- existing script tests under `scripts/*.test.ts` — patterns for extracting shell logic into testable helpers if needed

**Affected files:**
- `scripts/release.sh` — commit selection and classification path
- `scripts/*` helper module(s) or tests if extraction is needed for deterministic coverage
- `CHANGELOG.md` — only if manual fixture/update is needed for tests, not as a primary target

---

## Goals

1. Must exclude exact internal workflow commits like `mark task done` from generated release notes.
2. Must exclude backlog-only bookkeeping commits such as `chore(backlog): ...` from generated release notes.
3. Must keep release-worthy `feat(...)`, `fix(...)`, and real user-facing `docs(...)` changes included.
4. Must preserve the existing changelog section format unless filtering requires a minimal incidental adjustment.
5. Must keep first-release and no-previous-tag behavior deterministic.
6. Must make the filtering policy explicit in one place rather than scattering ad hoc shell filters.

---

## Implementation

### Step 1 — Define the exclusion policy in one helper path

**File:** `scripts/release.sh`

Replace the current one-off `grep -v '^chore(release):'` style filtering with one explicit inclusion/exclusion path. A small shell helper such as `should_include_commit()` or `is_release_note_worthy()` is preferred over stacking more inline filters.

At minimum, exclude:
- `mark task done`
- `chore(backlog): ...`
- `chore(release): ...`

Keep the policy narrow so real user-facing changes are not dropped accidentally.

### Step 2 — Preserve existing category grouping

**File:** `scripts/release.sh`

Keep the current `Added` / `Changed` / `Fixed` / `Other` grouping. Only change the input commit stream, not the visible release-note structure, unless a tiny incidental refactor is needed to make the filtering testable.

### Step 3 — Add regression coverage for release-note filtering

**Files:** `scripts/*.test.ts`, or a new helper extracted from `scripts/release.sh`

Cover representative commit subjects including:
- `mark task done`
- `chore(backlog): add dynamic worker architecture tasks`
- `chore(release): v0.1.2`
- `fix(release): filter internal commits from changelog`
- `feat(runtime): add dynamic provider routing`
- `docs(cli): clarify init flow`

Assert that internal workflow noise is excluded while real release-worthy commits remain and are classified into the same sections as before.

### Step 4 — Verify with a realistic mixed commit sample

**Files:** test fixture or helper test only

Use a mixed sample resembling the noisy changelog the user observed. Confirm the generated section no longer includes task bookkeeping entries while still containing the user-facing docs/runtime changes that should ship.

---

## Acceptance criteria

- [ ] Generated changelog sections no longer include `mark task done`.
- [ ] Generated changelog sections no longer include `chore(backlog): ...` bookkeeping commits.
- [ ] `chore(release): ...` remains excluded.
- [ ] Real `feat(...)`, `fix(...)`, and user-facing `docs(...)` commits are still included.
- [ ] The visible release-note section structure remains `Added`, `Changed`, `Fixed`, and `Other`.
- [ ] Filtering logic is implemented through one explicit policy path, not scattered ad hoc exclusions.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update script tests to cover:

```ts
it('excludes internal workflow commits from release notes', () => { ... });
it('keeps user-facing feat/fix/docs commits in release notes', () => { ... });
it('preserves category grouping after filtering noisy commit subjects', () => { ... });
it('handles mixed commit samples without reintroducing mark task done', () => { ... });
```

---

## Verification

```bash
npx vitest run scripts/*.test.ts
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Over-broad filtering can silently drop real release-worthy commits, while under-broad filtering leaves internal workflow noise in public notes.
**Rollback:** `git restore scripts/release.sh scripts/*.test.ts && npm test`
