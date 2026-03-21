---
ref: general/28-ci-test-job
feature: general
priority: normal
status: todo
depends_on:
  - general/26-ci-pipeline-setup
---

# Task 28 — Add Test Job to CI

Depends on Task 26. Blocks Task 30.

## Scope

**In scope:**
- Adding `npm test` to the `test` job in `.github/workflows/ci.yml`
- Uploading the coverage report as a CI artifact
- Configuring a coverage threshold failure gate (fail if below 80%)

**Out of scope:**
- Creating or modifying Vitest configuration for coverage
- Adding or changing `package.json` scripts
- Touching the `lint` or `build` jobs

---

## Context

Task 26 creates the CI pipeline with a `test` job skeleton that only installs dependencies. This task adds the test run command, uploads coverage output as an artifact, and enforces an 80% coverage minimum. Coverage output is assumed to land in a `coverage/` directory (standard Vitest default).

Task 27 (lint job) runs in parallel with this task — neither depends on the other's output.

**Affected files:**
- `.github/workflows/ci.yml` — `test` job extended with run and upload steps

---

## Goals

1. Must add `npm test` as a step in the `test` job.
2. Must upload the `coverage/` directory as a GitHub Actions artifact named `coverage-report`.
3. Must fail the job if coverage drops below 80%.
4. Must not modify the `lint` or `build` jobs.
5. Must leave the file valid YAML after the edit.

---

## Implementation

### Step 1 — Add test run, coverage threshold, and artifact upload to `.github/workflows/ci.yml`

**File:** `.github/workflows/ci.yml`

Extend the `test` job steps (after `npm ci`) to add:

```yaml
      - run: npm test -- --coverage --coverage.thresholds.lines=80
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverage-report
          path: coverage/
```

The resulting `test` job steps section:

```yaml
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm ci
      - run: npm test -- --coverage --coverage.thresholds.lines=80
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverage-report
          path: coverage/
```

The `--coverage.thresholds.lines=80` flag causes Vitest to exit non-zero if line coverage falls below 80%, which fails the CI job.

---

## Acceptance criteria

- [ ] The `test` job in `.github/workflows/ci.yml` runs `npm test` with coverage enabled.
- [ ] The job fails if line coverage is below 80%.
- [ ] Coverage output is uploaded as an artifact named `coverage-report`.
- [ ] The `lint` and `build` jobs are unchanged.
- [ ] `.github/workflows/ci.yml` remains valid YAML.
- [ ] No changes to files outside the stated scope.

---

## Tests

No unit tests apply. Verification is done via YAML validation and manual review.

---

## Verification

```bash
# Validate YAML syntax
node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/ci.yml','utf8')); console.log('YAML valid')"
nvm use 24 && npm test
```
