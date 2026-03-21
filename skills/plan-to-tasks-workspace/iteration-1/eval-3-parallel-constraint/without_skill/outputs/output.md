# Backlog Tasks — CI Pipeline

I've created 5 backlog task specs from the plan. Steps 2 and 3 are independent of each other (both depend only on Task 1), so they can be worked in parallel.

## Dependency graph

```
Task 1 (CI pipeline skeleton)
├── Task 2 (lint job)    ─┐
└── Task 3 (test job)    ─┤── Task 5 (deploy job)
    Task 4 (build job)  ──┘
```

Tasks 2, 3, and 4 all depend on Task 1 and are otherwise independent of each other. Task 5 depends on all three.

## Tasks

### Task 1 — Set Up the CI Pipeline Skeleton
**ref:** `ci/1-setup-ci-pipeline`
**depends on:** nothing (independent)
**blocks:** Tasks 2, 3, 4

Creates `.github/workflows/ci.yml` with triggers for push and pull_request to `main`, four job stubs (`lint`, `test`, `build`, `deploy`) each using `ubuntu-latest` and Node 24, and `deploy` wired to `needs: [lint, test, build]`. Job bodies are stubs to be filled in by subsequent tasks.

---

### Task 2 — Implement the Lint Job in CI
**ref:** `ci/2-lint-job`
**depends on:** Task 1
**blocks:** Task 5
**parallel with:** Task 3

Replaces the lint job stub with real steps: `npm ci` then `npm run lint`. Any ESLint error causes a non-zero exit and fails the job.

---

### Task 3 — Implement the Test Job in CI
**ref:** `ci/3-test-job`
**depends on:** Task 1
**blocks:** Task 5
**parallel with:** Task 2

Replaces the test job stub with real steps: `npm ci`, `npm test` with coverage enabled and an 80% threshold enforced, and uploads the coverage directory as a `coverage-report` artifact.

---

### Task 4 — Implement the Build Job in CI
**ref:** `ci/4-build-job`
**depends on:** Task 1
**blocks:** Task 5

Replaces the build job stub with real steps: `npm ci`, `npm run build` (fails on TypeScript errors), and uploads `dist/` as a `dist` artifact.

---

### Task 5 — Implement the Deploy Job in CI
**ref:** `ci/5-deploy-job`
**depends on:** Tasks 2, 3, 4
**blocks:** nothing

Replaces the deploy job stub. Restricts execution to `push` events on `main` (not pull requests), downloads the `dist` artifact from the build job, and runs `scripts/deploy.sh`.

---

## Suggested dispatch order

1. Dispatch Task 1 first.
2. Once Task 1 is done, dispatch Tasks 2, 3, and 4 simultaneously (they are independent).
3. Once Tasks 2, 3, and 4 are all done, dispatch Task 5.
