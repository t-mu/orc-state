---
ref: general/146-github-actions-ci
feature: general
priority: high
status: done
---

# Task 146 — Add GitHub Actions CI Workflow

Independent.

## Scope

**In scope:**
- Create `.github/workflows/ci.yml` with test, typecheck, and lint on push to main and PRs
- Add CI status badge to `README.md`

**Out of scope:**
- Publishing workflow (npm publish automation)
- Matrix testing across multiple Node versions (pin to 24 only)
- Deployment, release, or CD pipelines
- Changes to test scripts or pretest hooks

---

## Context

The project has no CI/CD pipeline. Tests, linting, and type checking run locally
only. Consumers evaluating the package on npm or GitHub have no confidence signal
(green badge, passing checks on PRs). This is a publish-readiness blocker.

The existing `pretest` script in `package.json` already runs both `tsc` (two
configs) and `eslint` before every `npm test` invocation (line 66). A separate
lint/typecheck CI step would duplicate that work. The CI workflow should rely on
`npm test` (which triggers pretest) and add `npm run test:e2e` as a separate
step for granular failure reporting.

**Affected files:**
- `.github/workflows/ci.yml` — new file, CI workflow definition
- `README.md` — add status badge at top

---

## Goals

1. Must run tests, type checking, and linting on every push to main and every PR.
2. Must use Node 24 matching `.nvmrc`.
3. Must not duplicate lint/typecheck work (rely on pretest hook inside `npm test`).
4. Must run `npm run test:e2e` as a separate step for granular failure visibility.
5. Must add a CI status badge to `README.md`.

---

## Implementation

### Step 1 — Create CI workflow file

**File:** `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: 'npm'
      - run: npm ci
      - name: Unit tests (includes typecheck + lint via pretest)
        run: npm test
      - name: E2E tests
        run: npm run test:e2e
```

Invariant: do not add separate `npm run lint` or `npm run typecheck` steps — `pretest` handles both.

### Step 2 — Add status badge to README

**File:** `README.md`

Add badge after the `# orc-state` heading (line 1):

```markdown
# orc-state

[![CI](https://github.com/t-mu/orc-state/actions/workflows/ci.yml/badge.svg)](https://github.com/t-mu/orc-state/actions/workflows/ci.yml)
```

---

## Acceptance criteria

- [ ] `.github/workflows/ci.yml` exists and is valid YAML.
- [ ] Workflow triggers on push to `main` and on pull requests.
- [ ] Uses Node 24 via `node-version-file: '.nvmrc'`.
- [ ] Runs `npm ci` before tests.
- [ ] Runs `npm test` (which triggers pretest for typecheck + lint).
- [ ] Runs `npm run test:e2e` as a separate named step.
- [ ] No separate `npm run lint` or `npm run typecheck` steps exist.
- [ ] `README.md` contains a CI status badge linking to the workflow.
- [ ] No changes to files outside the stated scope.

---

## Tests

No new test files — this task creates CI infrastructure only.

Validate YAML syntax:

```bash
node -e "const yaml = require('yaml'); yaml.parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8'))"
```

---

## Verification

```bash
nvm use 24 && npm test
```
