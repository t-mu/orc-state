---
ref: general/27-ci-lint-job
feature: general
priority: normal
status: todo
depends_on:
  - general/26-ci-pipeline-setup
---

# Task 27 — Add Lint Job to CI

Depends on Task 26. Blocks Task 30.

## Scope

**In scope:**
- Adding `npm run lint` to the `lint` job in `.github/workflows/ci.yml`
- Configuring the lint job to fail fast on any lint error

**Out of scope:**
- Creating or modifying ESLint configuration files (`.eslintrc`, `eslint.config.*`)
- Adding or changing `package.json` scripts
- Touching the `test` or `build` jobs

---

## Context

Task 26 creates the CI pipeline with a `lint` job skeleton that only installs dependencies. This task adds the actual lint command so the job fails when ESLint reports errors. The `--max-warnings 0` flag ensures even warnings cause a failure.

**Affected files:**
- `.github/workflows/ci.yml` — `lint` job extended with run step

---

## Goals

1. Must add `npm run lint` as a step in the `lint` job.
2. Must cause the CI job to fail on any lint error or warning.
3. Must not add `continue-on-error` or suppress lint failure.
4. Must not modify the `test` or `build` jobs.
5. Must leave the file valid YAML after the edit.

---

## Implementation

### Step 1 — Add lint run step to `.github/workflows/ci.yml`

**File:** `.github/workflows/ci.yml`

Extend the `lint` job steps (after `npm ci`) to add:

```yaml
      - run: npm run lint
```

The resulting `lint` job steps section:

```yaml
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm ci
      - run: npm run lint
```

If `npm run lint` is not already defined in `package.json`, note this in a comment — but do not modify `package.json` as that is out of scope.

---

## Acceptance criteria

- [ ] The `lint` job in `.github/workflows/ci.yml` runs `npm run lint`.
- [ ] No `continue-on-error: true` on the lint step.
- [ ] The `test` and `build` jobs are unchanged.
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
