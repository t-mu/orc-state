---
ref: general/160-activity-based-staleness
feature: general
priority: high
status: todo
review_level: full
---

# Task 160 — Replace Heartbeat with Activity-Based Staleness Detection

Independent.

## Scope

**In scope:**
- Add `review_submitted` to `PHASE_EVENTS` in `lib/workerLifecycleReducer.ts` for lease renewal
- Add configurable staleness thresholds to coordinator config (`lib/providers.ts`)
- Update `enforceInProgressLifecycle()` in `coordinator.ts` to use tiered inactivity response
- Remove all heartbeat instructions from `templates/worker-bootstrap-v2.txt` (6 references)
- Remove heartbeat requirement from `AGENTS.md`
- Deprecate `cli/run-heartbeat.ts` (no-op with warning)
- Remove heartbeat contract from `docs/contracts.md`
- Document new thresholds in `docs/configuration.md`

**Out of scope:**
- Changing the `last_heartbeat_at` field name (keep as-is; lifecycle reducer already updates it on phase events)
- Changes to `lib/claimManager.ts` heartbeat() function (still called internally by lifecycle reducer)
- Review level changes (Task 159)
- Skill text changes (Task 158)

---

## Context

### Current state

Workers emit explicit `orc run-heartbeat` commands at 3 lifecycle points
(before reviewers, before rebase, before run-work-complete). The lifecycle
reducer (`lib/workerLifecycleReducer.ts:53-59`) already renews leases
automatically when processing phase events (`phase_started`, `phase_finished`,
`blocked`, `need_input`, `input_provided`, `unblocked`). This means the
explicit worker-side heartbeat calls are redundant for lease renewal — the
coordinator already extends the lease on every phase transition.

The default lease duration is 30 minutes (`lib/constants.ts:21`,
`DEFAULT_LEASE_MS = 30 * 60 * 1000`). Phase events keep the lease alive
for normal task flows. However, `review_submitted` is NOT in the
`PHASE_EVENTS` set, so a long review phase could approach lease expiry
without renewal.

The current staleness detection in `enforceInProgressLifecycle()`
(coordinator.ts:964-1150) calculates `idleMs` per run and applies
remediation policies. It uses `last_heartbeat_at` as one signal, but
this field is already updated by the lifecycle reducer on phase events.

### Desired state

Remove explicit heartbeat from the worker protocol. Use activity-based
staleness detection with configurable tiered responses:
- Soft alert at 30 min (notification to master)
- Nudge at 60 min (message into PTY)
- Force-fail at 2 hours (safety net)
- PID-dead detection remains immediate (every coordinator tick)

**Start here:** `lib/workerLifecycleReducer.ts` line 53 (PHASE_EVENTS set)

**Affected files:**
- `lib/workerLifecycleReducer.ts` — add `review_submitted` to PHASE_EVENTS
- `lib/providers.ts` — add staleness threshold config fields
- `coordinator.ts` — update `enforceInProgressLifecycle()` with tiered thresholds
- `templates/worker-bootstrap-v2.txt` — remove 6 heartbeat references
- `AGENTS.md` — remove heartbeat requirement, Phase 3/4/5 mentions, blessed path
- `cli/run-heartbeat.ts` — deprecate (no-op with warning)
- `docs/contracts.md` — remove heartbeat contract (lines 274-295, 319, 382)
- `docs/configuration.md` — document new staleness thresholds

---

## Goals

1. Must add `review_submitted` to PHASE_EVENTS so review phases renew the lease.
2. Must add configurable staleness thresholds to coordinator config.
3. Must implement tiered inactivity response (30min soft → 60min nudge → 2h force-fail).
4. Must remove all explicit heartbeat instructions from worker bootstrap (6 references).
5. Must remove heartbeat requirement from AGENTS.md.
6. Must deprecate `cli/run-heartbeat.ts` as no-op (backward compatible).
7. Must not cause false positives — long implement phases must not trigger premature kills.

---

## Implementation

### Step 1 — Add review_submitted to PHASE_EVENTS

**File:** `lib/workerLifecycleReducer.ts`

Add `'review_submitted'` to the PHASE_EVENTS set at line 53:

```typescript
const PHASE_EVENTS = new Set([
  'phase_started',
  'phase_finished',
  'blocked',
  'need_input',
  'input_provided',
  'unblocked',
  'review_submitted',   // ← add this
]);
```

This ensures the lease is renewed when reviews are submitted during Phase 3.

### Step 2 — Add staleness config fields

**File:** `lib/providers.ts`

Add to `CoordinatorConfig` interface and defaults:

```typescript
// Staleness detection thresholds (ms)
worker_stale_soft_ms: number;        // default: 1_800_000  (30 min)
worker_stale_nudge_ms: number;       // default: 3_600_000  (60 min)
worker_stale_force_fail_ms: number;  // default: 7_200_000  (2 hours)
```

Add parsing in `loadCoordinatorConfig()` using `parsePositiveInteger`.

### Step 3 — Update enforceInProgressLifecycle with tiered response

**File:** `coordinator.ts`

In `enforceInProgressLifecycle()` (line 964), after calculating `idleMs` (line 988),
add tiered staleness handling:

```typescript
const { worker_stale_soft_ms, worker_stale_nudge_ms, worker_stale_force_fail_ms } = COORD_CONFIG;

// Tier 1: Soft alert (notification to master)
if (idleMs >= worker_stale_soft_ms && idleMs < worker_stale_nudge_ms) {
  // Emit worker_needs_attention if not already emitted for this threshold
  if (!claim.escalation_notified_at || ...) {
    emitWorkerNeedsAttention(claim, agent, idleMs);
  }
}

// Tier 2: Nudge (send message into PTY)
if (idleMs >= worker_stale_nudge_ms && idleMs < worker_stale_force_fail_ms) {
  // Send nudge into worker PTY session
  sendNudgeMessage(claim, agent);
}

// Tier 3: Force-fail (safety net — 2 hours with no activity)
if (idleMs >= worker_stale_force_fail_ms) {
  finishRun(STATE_DIR, claim.run_id, claim.agent_id, {
    success: false,
    failureReason: `force-failed after ${Math.round(idleMs / 60000)}min of inactivity`,
    failureCode: 'ERR_STALE_WORKER',
    policy: 'requeue',
  });
}
```

Integrate with existing remediation policy evaluation. The existing
`evaluateRemediationPolicies()` and `executeRemediation()` functions may
already handle some of these tiers — verify and extend rather than duplicate.

**PID-dead detection** remains unchanged — `probeActiveWorkerSessions()`
catches dead PIDs every tick (~30s), regardless of staleness thresholds.

### Step 4 — Remove heartbeat from worker bootstrap

**File:** `templates/worker-bootstrap-v2.txt`

Remove these 6 heartbeat references:

1. **Lines 30-33** (command definition): Remove the `run-heartbeat` command entry.
   Replace with a one-liner:
   ```
   # Lease renewal is automatic — the coordinator extends your lease on every phase signal.
   ```

2. **Line 91** ("emit heartbeat before spawning"): Remove entirely.

3. **Line 144** ("heartbeat before rebase"): Remove entirely.

4. **Line 153** ("heartbeat immediately before work-complete"): Remove entirely.

5. **Line 159** ("emit a heartbeat, do the requested rebase"): Replace with
   "do the requested rebase work" (remove heartbeat mention only).

6. **Line 208** (RULES section): Remove the heartbeat rule. Replace with:
   ```
   - Lease renewal is automatic via phase signals. You do not need to call orc run-heartbeat.
   ```

### Step 5 — Remove heartbeat from AGENTS.md

**File:** `AGENTS.md`

Remove:
- The "Heartbeat requirement" section (the one that says "Workers emit `orc run-heartbeat` as a **protocol signal**")
- Heartbeat from Phase 3: "Emit a heartbeat before spawning sub-agent reviewers"
- Heartbeat from Phase 4: "Immediately before `git rebase main`" and "Immediately before `orc run-work-complete`"
- Heartbeat from the Worker Commands table (`run-heartbeat` row)
- Heartbeat from the blessed path list

Add a note in the Heartbeat requirement section's former location:
```markdown
### Worker liveness

Liveness is determined by the coordinator probing the worker's PTY PID
on each tick. If the PID is dead, the coordinator clears the session,
expires the claim, and requeues the task. Lease renewal is automatic —
the coordinator extends the lease whenever phase events are processed.
```

### Step 6 — Deprecate cli/run-heartbeat.ts

**File:** `cli/run-heartbeat.ts`

Replace implementation with:

```typescript
console.warn('orc run-heartbeat is deprecated. Lease renewal is now automatic via phase signals.');
process.exit(0);
```

Keep the command registered in `cli/orc.ts` so existing workers don't get
"command not found" errors.

### Step 7 — Remove heartbeat contract from docs

**File:** `docs/contracts.md`

Remove:
- Lines 274-295: "Heartbeat contract" section (background loop, lease renewal)
- Line 319: "orc run-heartbeat (repeating, extends lease)" in lifecycle diagram
- Line 382: "background heartbeat loop during the wait" reference

Replace with a short "Worker liveness" section matching the AGENTS.md text.

### Step 8 — Document staleness thresholds

**File:** `docs/configuration.md`

Add to coordinator config table:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `worker_stale_soft_ms` | integer | `1800000` | Inactivity before soft alert (30 min). |
| `worker_stale_nudge_ms` | integer | `3600000` | Inactivity before PTY nudge (60 min). |
| `worker_stale_force_fail_ms` | integer | `7200000` | Inactivity before force-fail (2 hours). |

---

## Acceptance criteria

- [ ] `review_submitted` is in the PHASE_EVENTS set in `lib/workerLifecycleReducer.ts`.
- [ ] Staleness thresholds are configurable in `lib/providers.ts` CoordinatorConfig.
- [ ] `enforceInProgressLifecycle()` implements tiered inactivity response.
- [ ] 30-min soft alert emits `worker_needs_attention` notification.
- [ ] 60-min nudge sends message into PTY session.
- [ ] 2-hour force-fail expires the run with `policy: requeue`.
- [ ] PID-dead detection remains immediate (unchanged).
- [ ] All 6 heartbeat references removed from worker bootstrap.
- [ ] Heartbeat requirement removed from AGENTS.md (replaced with liveness section).
- [ ] `cli/run-heartbeat.ts` is a no-op with deprecation warning.
- [ ] Heartbeat contract removed from `docs/contracts.md`.
- [ ] Staleness thresholds documented in `docs/configuration.md`.
- [ ] `last_heartbeat_at` field name unchanged.
- [ ] `npm test` passes.
- [ ] `orc doctor` exits 0.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/workerLifecycleReducer.test.ts`:

```typescript
it('renews lease on review_submitted event', () => { ... });
```

Add to `coordinator.test.ts` or a dedicated staleness test file:

```typescript
it('emits worker_needs_attention after worker_stale_soft_ms inactivity', () => { ... });
it('sends nudge after worker_stale_nudge_ms inactivity', () => { ... });
it('force-fails run after worker_stale_force_fail_ms inactivity', () => { ... });
it('does not trigger staleness for active workers with recent phase events', () => { ... });
it('immediately expires claim when PID is dead regardless of thresholds', () => { ... });
```

Add to `cli/run-heartbeat.test.ts`:

```typescript
it('exits 0 with deprecation warning', () => { ... });
```

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
orc doctor
```

---

## Risk / Rollback

**Risk:** Removing heartbeat could cause lease expiry during long implement phases if no phase events fire within 30 minutes. Mitigated by: (1) `phase_started: implement` fires at the start, (2) `review_submitted` now renews lease, (3) PID probing catches dead workers within 30s regardless. The 2-hour force-fail is a safety net for truly stuck workers.

**Risk:** Existing workers (from prior bootstrap) still call `orc run-heartbeat`. Mitigated by: deprecated CLI command exits 0 cleanly — no breakage.

**Rollback:** `git restore lib/workerLifecycleReducer.ts coordinator.ts lib/providers.ts templates/worker-bootstrap-v2.txt AGENTS.md cli/run-heartbeat.ts docs/contracts.md docs/configuration.md && npm test`
