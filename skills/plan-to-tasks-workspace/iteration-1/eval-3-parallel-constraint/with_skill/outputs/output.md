# Plan to Tasks — CI Pipeline

Plan: Set up CI pipeline (5 steps)
Feature: general

## Step 3 — Preview

  #    slug                    title                              deps
  26   26-ci-pipeline-setup    Set Up the CI Pipeline             Independent
  27   27-ci-lint-job          Add Lint Job to CI                 Depends on 26
  28   28-ci-test-job          Add Test Job to CI                 Depends on 26
  29   29-ci-build-job         Add Build Job to CI                Depends on 26
  30   30-ci-deploy-job        Add Deploy Job to CI               Depends on 27, 28, 29

**Dependency rationale:**
- Task 26 creates the workflow file — all other tasks edit it, so they all depend on 26.
- Tasks 27 and 28 are independent of each other (user confirmed parallel execution).
- Task 29 is also independent of 27 and 28 — it edits a different job in the same file and produces the `dist/` artifact consumed by Task 30, not by 27 or 28.
- Task 30 depends on 27, 28, and 29 because the plan text explicitly states "Depends on lint, test, and build all passing."

---

## Tasks Created

### Task 26 — Set Up the CI Pipeline
- **File:** `backlog/26-ci-pipeline-setup.md`
- **Ref:** `general/26-ci-pipeline-setup`
- **Deps:** Independent
- **Registration:** ✓

### Task 27 — Add Lint Job to CI
- **File:** `backlog/27-ci-lint-job.md`
- **Ref:** `general/27-ci-lint-job`
- **Deps:** Depends on Task 26
- **Registration:** ✓

### Task 28 — Add Test Job to CI
- **File:** `backlog/28-ci-test-job.md`
- **Ref:** `general/28-ci-test-job`
- **Deps:** Depends on Task 26 (parallel with Task 27)
- **Registration:** ✓

### Task 29 — Add Build Job to CI
- **File:** `backlog/29-ci-build-job.md`
- **Ref:** `general/29-ci-build-job`
- **Deps:** Depends on Task 26 (parallel with Tasks 27 and 28)
- **Registration:** ✓

### Task 30 — Add Deploy Job to CI
- **File:** `backlog/30-ci-deploy-job.md`
- **Ref:** `general/30-ci-deploy-job`
- **Deps:** Depends on Tasks 27, 28, 29
- **Registration:** ✓

---

## Sync Check

```
orc backlog-sync-check
```

Result: ✓ All 5 refs in sync.

---

## Summary

5 tasks created. Tasks 27, 28, and 29 all depend only on Task 26 and can be executed in parallel. Task 30 is gated on all three completing.

> Note: This is a simulation — files were saved to the eval output directory, not to the live backlog.
