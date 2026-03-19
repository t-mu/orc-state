---
ref: general/17-lifecycle-invariants-and-operator-diagnostics
feature: general
priority: high
status: done
---

# Task 17 — Encode Lifecycle Invariants in Tooling and Diagnostics

Depends on Task 16. Blocks Task 18.

## Scope

**In scope:**
- Add explicit lifecycle invariant checks for invalid claim, run, and finalization states
- Surface those invariant failures clearly in operator-facing tooling such as `orc doctor` and `orc status`
- Improve diagnostics for spec/state drift, suspicious event-log conditions, and invalid worker/task combinations
- Add write-path guardrails so CLI and MCP task mutation paths respect markdown authority
- Keep duplicate active-claim resolution deterministic: oldest claim wins, newer duplicates are failed

**Out of scope:**
- Workflow simplification or command removal
- Large event model refactors beyond the checks needed to detect invalid states
- Failure-injection and replay hardening suites beyond the validations introduced here
- Automatic repair outside deterministic duplicate-claim cleanup

---

## Context

The orchestrator still relies on several implicit assumptions that are not consistently encoded in tooling. When those assumptions are violated, the operator often sees a confusing downstream symptom instead of a direct explanation of the invalid state.

### Current state

Some runtime protections exist, but they are spread across the coordinator, CLI entrypoints, and tests. `orc doctor` and `orc status` do not yet present a complete, explicit picture of lifecycle invariant failures, which makes recovery more manual than it should be. Generic task mutation paths can also bypass the markdown-authority contract unless each surface adds its own ad hoc checks.

### Desired state

The system should reject or flag impossible lifecycle states early and surface actionable diagnostics through the existing operator commands. Hidden assumptions should become explicit checks with clear failure messages. `orc status` should fail fast on invalid runtime state instead of printing misleading partial output, and generic CLI/MCP task mutation paths should reject markdown-authoritative field changes.

### Start here

- `cli/doctor.ts` — current health and validation output
- `cli/status.ts` — current state summary output
- `coordinator.ts` and `lib/claimManager.ts` — identify the lifecycle states and invariants that need to be enforced
- `cli/task-create.ts` and `mcp/handlers.ts` — runtime task mutation paths that must respect markdown authority

**Affected files:**
- `cli/doctor.ts` — new invariant checks and messaging
- `cli/status.ts` — hard failure and actionable error surfacing for invalid state
- `lib/*` validation helpers — shared invariant detection logic
- `cli/task-create.ts` and MCP handler/task schemas — write-path guardrails aligned with markdown authority
- `schemas/*.json` — only if invariant data requires schema changes

---

## Goals

1. Must detect invalid lifecycle combinations instead of silently tolerating them.
2. Must surface invariant failures through `orc doctor` with actionable messages.
3. Must make `orc status` fail fast on suspicious or contradictory runtime states.
4. Must cover spec/state drift and event-log anomalies that operators are expected to diagnose.
5. Must align CLI and MCP write paths with markdown-authoritative task fields.
6. Must resolve duplicate active claims deterministically by keeping the oldest claim and failing newer duplicates.

---

## Implementation

### Step 1 — Identify and codify invariants

**File:** `lib/*`

Extract the lifecycle invariants that should hold across claim state, finalization state, worker assignment, and terminal run handling.

### Step 2 — Wire invariant checks into doctor

**File:** `cli/doctor.ts`

Add explicit validation output for invalid lifecycle combinations, event-log anomalies, and spec/state inconsistencies.

### Step 3 — Improve operator-facing status output

**File:** `cli/status.ts`

Fail hard with actionable invariant output where the operator would otherwise see misleading status tables.

### Step 4 — Align write-path guardrails

**File:** `cli/task-create.ts` and `mcp/handlers.ts`

Reject generic task registration or update operations that conflict with markdown-authoritative task fields, while preserving dedicated lifecycle commands for state transitions.

### Step 5 — Deterministic duplicate-claim cleanup

**File:** `lib/reconcile.ts`

When multiple active claims exist for the same task, keep the oldest claim and fail newer duplicates so the system self-heals to one winner without blocking.

---

## Acceptance criteria

- [ ] Invalid lifecycle combinations are detected by shared validation logic instead of being left implicit.
- [ ] `orc doctor` reports actionable diagnostics for lifecycle, sync, and suspicious event-log conditions in scope.
- [ ] `orc status` exits non-zero and reports invalid or contradictory runtime states clearly.
- [ ] CLI and MCP task mutation paths reject markdown-authoritative field changes through generic update surfaces.
- [ ] Deterministic duplicate-claim resolution keeps the oldest active claim and fails newer duplicates.
- [ ] The new diagnostics do not mutate orchestrator state.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `cli/doctor.test.ts`, `cli/status.test.ts`, and related lifecycle/write-path tests:

```ts
it('reports invalid claim and finalization combinations', () => { ... });
it('flags spec/state drift and suspicious event-log conditions', () => { ... });
it('fails status on contradictory runtime state', () => { ... });
it('keeps the oldest duplicate active claim and fails newer duplicates', () => { ... });
it('rejects markdown-authoritative task field mutation through generic create/update paths', () => { ... });
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
