---
ref: ci/3-test-job
feature: ci
priority: normal
status: todo
---

# Task 3 — Implement the Test Job in CI

Depends on Task 1. Blocks Task 5.

## Scope

**In scope:**
- Replace the stub `test` job steps in `.github/workflows/ci.yml` with real steps: install dependencies, run `npm test`, upload coverage report as a workflow artifact, and enforce an 80% coverage threshold
- Configure coverage threshold enforcement (fail if below 80%)

**Out of scope:**
- Changes to the `lint`, `build`, or `deploy` jobs
- Changes to `vitest.config.*` beyond what is needed to emit a coverage report
- Modifications to test files or source code

---

## Context

Task 1 created the CI pipeline skeleton with a stub `test` job. This task fills in the real steps so that every push and pull request to `main` runs the test suite, enforces coverage, and preserves the coverage report as a downloadable artifact.

### Current state

The `test` job in `.github/workflows/ci.yml` contains only a placeholder `run: echo "TODO: test steps"`. No tests run in CI and coverage is not tracked.

### Desired state

The `test` job runs `npm test`, enforces an 80% coverage minimum (failing the job if not met), and uploads the coverage report directory as a GitHub Actions artifact named `coverage-report`.

### Start here

- `.github/workflows/ci.yml` — replace the test job stub steps
- `package.json` — confirm `test` script and any coverage flags
- `vitest.config.*` (if present) — check existing coverage configuration

**Affected files:**
- `.github/workflows/ci.yml` — update test job steps only

---

## Goals

1. Must run `npm ci` to install dependencies before testing.
2. Must run `npm test` as the test step.
3. Must fail the job if the test suite exits non-zero.
4. Must fail the job if line/branch/function coverage falls below 80%.
5. Must upload the coverage output directory as an artifact named `coverage-report`.
6. Must not modify the `lint`, `build`, or `deploy` job sections.

---

## Implementation

### Step 1 — Replace test job stub in `.github/workflows/ci.yml`

**File:** `.github/workflows/ci.yml`

Replace the existing test job steps:

```yaml
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - name: Install dependencies
        run: npm ci
      - name: Run tests with coverage
        run: npm test -- --coverage --coverage.thresholds.lines=80 --coverage.thresholds.branches=80 --coverage.thresholds.functions=80
      - name: Upload coverage report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coverage-report
          path: coverage/
```

<!-- Invariant: do not modify the lint, build, or deploy job definitions -->
<!-- Note: if vitest.config already sets coverage thresholds, remove the inline flags and rely on the config -->

---

## Acceptance criteria

- [ ] `test` job steps contain `npm ci` followed by a test run that includes coverage.
- [ ] Job exits non-zero if any test fails.
- [ ] Job exits non-zero if coverage drops below 80%.
- [ ] Coverage report directory is uploaded as artifact `coverage-report` on every run (pass or fail).
- [ ] No placeholder `echo "TODO"` steps remain in the `test` job.
- [ ] `lint`, `build`, and `deploy` job definitions are unchanged.
- [ ] No changes outside `.github/workflows/ci.yml`.

---

## Tests

No automated tests for CI YAML. Validate manually:

```bash
npx js-yaml .github/workflows/ci.yml
```

---

## Verification

```bash
# Confirm test steps are present
grep -A 20 'test:' .github/workflows/ci.yml

# Validate YAML
npx js-yaml .github/workflows/ci.yml

# Repo-wide checks
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Coverage threshold flags may differ between Vitest versions; inline flags could conflict with `vitest.config` thresholds.
**Rollback:** Revert the test job steps to the stub. If coverage config is the issue, move thresholds to `vitest.config` and remove inline flags.
