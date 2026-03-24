#!/usr/bin/env node
/**
 * cli/review-read.ts
 * Usage: orc review-read --run-id=<id> [--json]
 *
 * Retrieves all review_submitted events for a run from SQLite,
 * deduplicated by agent_id (latest submission wins).
 * Always exits 0 — the worker decides whether to proceed.
 */
import { queryEvents } from '../lib/eventLog.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { flag } from '../lib/args.ts';
import type { ReviewSubmittedEvent } from '../types/events.ts';

const runId = flag('run-id');
const asJson = process.argv.includes('--json');

if (!runId) {
  console.error('--run-id is required');
  process.exit(1);
}

const events = queryEvents(STATE_DIR, {
  run_id: runId,
  event_type: 'review_submitted',
  limit: 100,
}) as ReviewSubmittedEvent[];

// Deduplicate: keep latest event per agent_id
const byAgent = new Map<string, ReviewSubmittedEvent>();
for (const e of events) {
  byAgent.set(e.agent_id, e);
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
  console.log(`\n--- Review from ${r.agent_id} [${r.payload.outcome}] ---`);
  console.log(r.payload.findings);
}
