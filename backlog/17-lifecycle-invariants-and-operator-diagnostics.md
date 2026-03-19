---
ref: general/17-lifecycle-invariants-and-operator-diagnostics
feature: general
priority: high
status: todo
---

# Task 17 — Encode Lifecycle Invariants in Tooling and Diagnostics

Depends on Task 16. Blocks Task 18.

## Scope

**In scope:**
- Add explicit lifecycle invariant checks for invalid claim, run, and finalization states
- Surface those invariant failures clearly in operator-facing tooling such as `orc doctor` and `orc status`
- Improve diagnostics for spec/state drift, suspicious event-log conditions, and invalid worker/task combinations
- Keep the changes focused on validation, detection, and messaging

**Out of scope:**
- Workflow simplification or command removal
- Large event model refactors beyond the checks needed to detect invalid states
- Failure-injection and replay hardening suites beyond the validations introduced here

---

## Context

The orchestrator still relies on several implicit assumptions that are not consistently encoded in tooling. When those assumptions are violated, the operator often sees a confusing downstream symptom instead of a direct explanation of the invalid state.

### Current state

Some runtime protections exist, but they are spread across the coordinator, CLI entrypoints, and tests. `orc doctor` and `orc status` do not yet present a complete, explicit picture of lifecycle invariant failures, which makes recovery more manual than it should be.

### Desired state

The system should reject or flag impossible lifecycle states early and surface actionable diagnostics through the existing operator commands. Hidden assumptions should become explicit checks with clear failure messages.

### Start here

- `cli/doctor.ts` — current health and validation output
- `cli/status.ts` — current state summary output
- `coordinator.ts` and `lib/claimManager.ts` — identify the lifecycle states and invariants that need to be enforced

**Affected files:**
- `cli/doctor.ts` — new invariant checks and messaging
- `cli/status.ts` — operator-visible warnings or error surfacing
- `lib/*` validation helpers — shared invariant detection logic
- `schemas/*.json` — only if invariant data requires schema changes

---

## Goals

1. Must detect invalid lifecycle combinations instead of silently tolerating them.
2. Must surface invariant failures through `orc doctor` with actionable messages.
3. Must make `orc status` reflect suspicious or contradictory runtime states clearly.
4. Must cover spec/state drift and event-log anomalies that operators are expected to diagnose.
5. Must not simplify or remove workflows yet; this task is detection-first.

---

## Implementation

### Step 1 — Identify and codify invariants

**File:** `lib/claimManager.ts`

Extract the lifecycle invariants that should hold across claim state, finalization state, worker assignment, and terminal run handling.

### Step 2 — Wire invariant checks into doctor

**File:** `cli/doctor.ts`

Add explicit validation output for invalid lifecycle combinations, event-log anomalies, and spec/state inconsistencies.

### Step 3 — Improve operator-facing status output

**File:** `cli/status.ts`

Surface warnings or invalid-state indicators where the operator needs to see them during normal inspection.

---

## Acceptance criteria

- [ ] Invalid lifecycle combinations are detected by shared validation logic instead of being left implicit.
- [ ] `orc doctor` reports actionable diagnostics for lifecycle, sync, and suspicious event-log conditions in scope.
- [ ] `orc status` makes invalid or contradictory runtime states visible to the operator.
- [ ] The new diagnostics do not mutate orchestrator state.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `cli/doctor.test.ts` and `cli/status.test.ts`:

```ts
it('reports invalid claim and finalization combinations', () => { ... });
it('flags spec/state drift and suspicious event-log conditions', () => { ... });
it('surfaces lifecycle warnings in status output without mutating state', () => { ... });
```

---

## Verification

```bash
# Targeted verification for this task only
npx vitest run cli/doctor.test.ts cli/status.test.ts
```

```bash
# Final required repo-wide checks before marking the task done
nvm use 24 && npm test
```

```bash
# Smoke checks — include only when schema, state, or CLI changes are in scope
orc doctor
orc status
# Expected: exits 0, no validation errors
```

---

## Risk / Rollback

**Risk:** Overly broad invariants or noisy diagnostics could produce false positives and reduce trust in operator tooling.
**Rollback:** Revert the new invariant checks and diagnostic output together, then rerun `orc doctor` to confirm the prior baseline.
