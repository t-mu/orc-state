---
ref: ci/2-lint-job
feature: ci
priority: normal
status: todo
---

# Task 2 — Implement the Lint Job in CI

Depends on Task 1. Blocks Task 5.

## Scope

**In scope:**
- Replace the stub `lint` job steps in `.github/workflows/ci.yml` with real steps: install dependencies and run `npm run lint`
- Ensure the job fails fast on any ESLint error (non-zero exit from `npm run lint` fails the job by default)

**Out of scope:**
- ESLint configuration changes (`.eslintrc`, `eslint.config.*`) — not part of this task
- Changes to the `test`, `build`, or `deploy` jobs
- Modifications to `package.json` lint script

---

## Context

Task 1 created the CI pipeline skeleton with a stub `lint` job. This task fills in the real steps so that every push and pull request to `main` is automatically linted.

### Current state

The `lint` job in `.github/workflows/ci.yml` contains only a placeholder `run: echo "TODO: lint steps"`. No lint is actually executed in CI.

### Desired state

The `lint` job installs npm dependencies and runs `npm run lint`. Any ESLint error causes the job to exit non-zero, failing the CI check and blocking merge.

### Start here

- `.github/workflows/ci.yml` — replace the lint job stub steps
- `package.json` — confirm the `lint` script name and command

**Affected files:**
- `.github/workflows/ci.yml` — update lint job steps only

---

## Goals

1. Must run `npm ci` to install dependencies before linting.
2. Must run `npm run lint` as the lint step.
3. Must fail the job (exit non-zero) if `npm run lint` exits non-zero.
4. Must not modify the `test`, `build`, or `deploy` job sections.
5. Must not introduce any new npm dependencies or scripts.

---

## Implementation

### Step 1 — Replace lint job stub in `.github/workflows/ci.yml`

**File:** `.github/workflows/ci.yml`

Replace the existing lint job steps:

```yaml
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - name: Install dependencies
        run: npm ci
      - name: Lint
        run: npm run lint
```

<!-- Invariant: do not modify the test, build, or deploy job definitions -->

---

## Acceptance criteria

- [ ] `lint` job steps contain `npm ci` followed by `npm run lint`.
- [ ] No placeholder `echo "TODO"` steps remain in the `lint` job.
- [ ] A lint error in source code causes the `lint` job to exit non-zero.
- [ ] `test`, `build`, and `deploy` job definitions are unchanged.
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
# Confirm lint steps are present
grep -A 10 'lint:' .github/workflows/ci.yml

# Validate YAML
npx js-yaml .github/workflows/ci.yml

# Repo-wide checks
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** If `npm run lint` script does not exist, the CI job will fail immediately.
**Rollback:** Revert the lint job steps to the stub or fix the missing script in `package.json`.
