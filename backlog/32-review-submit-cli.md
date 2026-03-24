---
ref: general/32-review-submit-cli
feature: general
priority: normal
status: done
depends_on:
  - general/31-review-submitted-event-type
---

# Task 32 — Add `orc review-submit` CLI

Depends on Task 31. Blocks Task 33.

## Scope

**In scope:**
- `cli/review-submit.ts` — new CLI for reviewers to persist findings as a `review_submitted` event
- `cli/review-submit.test.ts` — unit tests
- `cli/orc.ts` — register `review-submit` in the command dispatch table

**Out of scope:**
- `cli/review-read.ts` (Task 33)
- `AGENTS.md` (Task 33)
- Any changes to `cli/progress.ts`
- Coordinator or state machine

---

## Context

Sub-agent reviewers currently return findings only as conversation text. If the worker's context is compacted while waiting for reviewers, those findings are lost. This CLI lets reviewers durably write their findings into the SQLite event store before returning.

Task 31 adds the `review_submitted` event type. This task adds the CLI that emits it.

### Current state

There is no way for a reviewer sub-agent to record its findings in the event store. The only option is returning text in conversation context, which is lost on compaction.

### Desired state

A reviewer sub-agent calls `orc review-submit` with its `run_id`, `agent_id`, `outcome`, and findings text. The event is written to SQLite. The worker can recover it later via `orc review-read` (Task 33) regardless of context compaction.

### Start here

- `cli/run-heartbeat.ts` — closest structural analogue; study its flag parsing, validation, and event emission pattern (~50 lines)
- `cli/run-fail.ts` — shows how `--reason` text is passed into payload
- `lib/progressValidation.ts` — `validateProgressCommandInput` signature and what it checks
- `cli/orc.ts` — where new commands are registered in the dispatch table

**Affected files:**
- `cli/review-submit.ts` — new file (~60 lines)
- `cli/review-submit.test.ts` — new file (~130 lines)
- `cli/orc.ts` — one-line registration

---

## Goals

1. Must: `orc review-submit --run-id=<id> --agent-id=<id> --outcome=<approved|findings> --reason=<text>` appends a `review_submitted` event to the SQLite store.
2. Must: the emitted event payload contains `{ outcome, findings: <reason text> }`.
3. Must: exits 1 with a clear error message when `--outcome` is not `approved` or `findings`.
4. Must: exits 1 with a clear error message when `--reason` is absent or empty.
5. Must: exits 1 with a clear error message when `--run-id` or `--agent-id` are missing.
6. Must: if the same `agent_id` submits twice for the same `run_id`, both events are stored (no deduplication at write time — `review-read` handles dedup at read time).
7. Must: `orc review-submit` is registered in `cli/orc.ts`.
8. Must: `npm test` passes.

---

## Implementation

### Step 1 — Create `cli/review-submit.ts`

**File:** `cli/review-submit.ts`

Follow the structure of `cli/run-heartbeat.ts`. Parse flags, validate, append event:

```typescript
#!/usr/bin/env node
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { STATE_DIR } from '../lib/paths.ts';
// parse --run-id, --agent-id, --outcome, --reason from process.argv

const VALID_OUTCOMES = ['approved', 'findings'] as const;

// Validate presence and values
if (!runId) { console.error('--run-id is required'); process.exit(1); }
if (!agentId) { console.error('--agent-id is required'); process.exit(1); }
if (!VALID_OUTCOMES.includes(outcome as never)) {
  console.error(`--outcome must be 'approved' or 'findings', got: ${outcome}`);
  process.exit(1);
}
if (!reason?.trim()) { console.error('--reason is required and must not be empty'); process.exit(1); }

appendSequencedEvent(STATE_DIR, {
  event: 'review_submitted',
  ts: new Date().toISOString(),
  actor_type: 'agent',
  actor_id: agentId,
  run_id: runId,
  agent_id: agentId,
  payload: { outcome, findings: reason },
});

console.log(`review_submitted: run=${runId} agent=${agentId} outcome=${outcome}`);
```

Note: `review_submitted` does not require a valid claim (reviewers are sub-agents, not registered workers). Do not call `validateProgressCommandInput` — validate flags directly.

### Step 2 — Register in `cli/orc.ts`

**File:** `cli/orc.ts`

Add `'review-submit'` to the command dispatch table, pointing to `./review-submit.ts`. Place it near other run lifecycle commands.

---

## Acceptance criteria

- [ ] `orc review-submit --run-id=run-abc --agent-id=reviewer-1 --outcome=approved --reason="LGTM"` exits 0 and writes a `review_submitted` event to SQLite.
- [ ] The stored event has `payload.outcome = 'approved'` and `payload.findings = 'LGTM'`.
- [ ] `--outcome=invalid` exits 1 with an error message containing `'approved' or 'findings'`.
- [ ] Missing `--reason` exits 1 with an error message.
- [ ] Missing `--run-id` exits 1 with an error message.
- [ ] Calling twice with the same `--agent-id` stores two separate events (no silent drop).
- [ ] `orc review-submit` appears in the `cli/orc.ts` dispatch table.
- [ ] `npm test` passes.
- [ ] No changes to `cli/progress.ts` or any file outside stated scope.

---

## Tests

**File:** `cli/review-submit.test.ts`

Follow the pattern in `cli/run-reporting.test.ts` (uses `spawnSync` + temp state dir):

```typescript
it('writes review_submitted event to SQLite on success', () => { ... });
it('stores outcome=approved with findings text in payload', () => { ... });
it('stores outcome=findings with full findings text', () => { ... });
it('exits 1 when --outcome is not approved or findings', () => { ... });
it('exits 1 when --reason is absent', () => { ... });
it('exits 1 when --run-id is missing', () => { ... });
it('exits 1 when --agent-id is missing', () => { ... });
it('stores two events when called twice with same agent-id (no dedup at write)', () => { ... });
```

---

## Verification

```bash
grep -n 'review-submit' cli/orc.ts
# Expected: command registration entry
```

```bash
nvm use 24 && npx vitest run cli/review-submit.test.ts
```

```bash
nvm use 24 && npm test
```
