---
ref: general/33-review-read-cli-and-agents-protocol
feature: general
priority: normal
status: done
depends_on:
  - general/32-review-submit-cli
---

# Task 33 — Add `orc review-read` CLI and Update Review Protocol in AGENTS.md

Depends on Tasks 31 and 32.

## Scope

**In scope:**
- `cli/review-read.ts` — new CLI to query `review_submitted` events for a run
- `cli/review-read.test.ts` — unit tests
- `cli/orc.ts` — register `review-read`
- `AGENTS.md` — update the review round protocol (step 2b–2d) to use `orc review-submit` and `orc review-read`; add note that reviewer spawn prompts must include the `orc review-submit` instruction

**Out of scope:**
- Changes to coordinator, state machine, or claims
- Any other AGENTS.md sections beyond the review round
- `cli/progress.ts`

---

## Context

Tasks 31 and 32 add the `review_submitted` event type and the `orc review-submit` CLI. This task adds the read side: a worker can call `orc review-read --run-id=<id>` to retrieve all reviewer findings from SQLite, even after context compaction.

The critical operational gap is that AGENTS.md instructs workers to "wait for a final response from both sub-agents" — which relies on conversation context. After compaction that context is gone. The fix requires two changes: the CLI to recover findings from SQLite, and AGENTS.md protocol changes so reviewers are instructed to call `orc review-submit` and workers call `orc review-read` to recover.

### Current state

Workers wait for reviewer sub-agents to return text in conversation context. If context is compacted during this wait, findings are lost and cannot be recovered. The review round must be abandoned or re-run.

### Desired state

Reviewer sub-agents call `orc review-submit` before returning (this must be explicit in the spawn prompt). Workers call `orc review-read --run-id=<id>` to retrieve all findings from SQLite. The worker decides whether to proceed based on the output — the CLI always exits 0, even if only 1 of 2 reviewers has responded (per AGENTS.md policy: proceed with completed reviews).

### Start here

- `cli/events-tail.ts` — closest structural analogue for query + format output
- `lib/eventLog.ts` — `queryEvents(stateDir, { run_id, event_type, limit })` already exists and does exactly what is needed
- `AGENTS.md` lines 60–72 — the current review round wording to update

**Affected files:**
- `cli/review-read.ts` — new file (~65 lines)
- `cli/review-read.test.ts` — new file (~120 lines)
- `cli/orc.ts` — one-line registration
- `AGENTS.md` — update review round steps 2b–2d

---

## Goals

1. Must: `orc review-read --run-id=<id>` queries SQLite for all `review_submitted` events with that `run_id` and prints them in a readable format.
2. Must: output is deduplicated by `agent_id` — if the same agent submitted twice, only the latest event is shown.
3. Must: exits 0 in all cases — 0 reviews, 1 review, 2+ reviews. The worker decides whether to proceed; the CLI does not enforce a minimum.
4. Must: `--json` flag outputs `{ count: N, reviews: [...] }` as JSON for programmatic use.
5. Must: when no reviews are found, prints a clear message (e.g. `No reviews found for run <id>`) and exits 0.
6. Must: AGENTS.md step 2b instructs workers to include `orc review-submit` in the reviewer spawn prompt.
7. Must: AGENTS.md step 2c instructs workers to call `orc review-read --run-id=<run_id>` to retrieve findings, noting this works after context compaction.
8. Must: `npm test` passes.

---

## Implementation

### Step 1 — Create `cli/review-read.ts`

**File:** `cli/review-read.ts`

Use `queryEvents` to fetch and deduplicate:

```typescript
#!/usr/bin/env node
import { queryEvents } from '../lib/eventLog.ts';
import { STATE_DIR } from '../lib/paths.ts';
// parse --run-id, --json from process.argv

if (!runId) { console.error('--run-id is required'); process.exit(1); }

const events = queryEvents(STATE_DIR, {
  run_id: runId,
  event_type: 'review_submitted',
  limit: 100,
});

// Deduplicate: keep latest event per agent_id
const byAgent = new Map<string, typeof events[0]>();
for (const e of events) {
  if (e.agent_id) byAgent.set(e.agent_id, e);
}
const reviews = [...byAgent.values()];

if (asJson) {
  console.log(JSON.stringify({ count: reviews.length, reviews }));
  process.exit(0);
}

if (reviews.length === 0) {
  console.log(`No reviews found for run ${runId}`);
  process.exit(0);
}

for (const r of reviews) {
  const payload = r.payload as { outcome: string; findings: string };
  console.log(`\n--- Review from ${r.agent_id} [${payload.outcome}] ---`);
  console.log(payload.findings);
}
```

### Step 2 — Register in `cli/orc.ts`

Add `'review-read'` to the dispatch table near `'review-submit'`.

### Step 3 — Update AGENTS.md review round

**File:** `AGENTS.md`

Replace steps 2b–2d in the review round section with:

```
#    b. Spawn two independent sub-agents. Give each:
#       - the acceptance criteria
#       - the output of `git diff main`
#       - their run_id, agent_id, and reviewer number
#       IMPORTANT: instruct each reviewer to call before returning:
#         orc review-submit --run-id=<run_id> --agent-id=<their_agent_id> \
#           --outcome=<approved|findings> --reason="<findings text>"
#       Findings written this way survive context compaction.
#
#    c. After both sub-agents complete (or after a bounded wait), retrieve
#       findings from the event store — this works even after context compaction:
#         orc review-read --run-id=<run_id>
#       If a reviewer failed or is non-responsive, proceed with the reviews
#       that were submitted. orc review-read exits 0 regardless of count.
#
#    d. Consolidate findings from the review-read output.
```

---

## Acceptance criteria

- [ ] `orc review-read --run-id=<id>` prints findings for all reviewers that submitted, deduplicated by `agent_id`.
- [ ] When a reviewer submits twice, only the latest submission is shown.
- [ ] `orc review-read --run-id=<id>` exits 0 when 0 reviews found, 1 review found, or 2+ reviews found.
- [ ] `--json` outputs `{ count: N, reviews: [...] }` as valid JSON and exits 0.
- [ ] Missing `--run-id` exits 1 with an error message.
- [ ] `orc review-read` is registered in `cli/orc.ts`.
- [ ] AGENTS.md step 2b explicitly tells workers to instruct reviewers to call `orc review-submit`.
- [ ] AGENTS.md step 2c tells workers to call `orc review-read --run-id=<run_id>` and notes it works after compaction.
- [ ] `npm test` passes.
- [ ] No changes outside stated scope.

---

## Tests

**File:** `cli/review-read.test.ts`

```typescript
it('returns all reviews for a run_id', () => { ... });
it('deduplicates by agent_id — keeps latest when same agent submits twice', () => { ... });
it('returns empty result and exits 0 when no reviews exist', () => { ... });
it('returns partial result and exits 0 when only 1 of 2 reviewers submitted', () => { ... });
it('--json outputs valid JSON with count and reviews array', () => { ... });
it('exits 1 when --run-id is missing', () => { ... });
it('does not return reviews from a different run_id', () => { ... });
```

---

## Verification

```bash
grep -n 'review-read\|review-submit' cli/orc.ts
# Expected: both commands registered
```

```bash
grep -n 'review-submit\|review-read\|compaction' AGENTS.md
# Expected: updated protocol in review round section
```

```bash
nvm use 24 && npx vitest run cli/review-read.test.ts
```

```bash
nvm use 24 && npm test
```
