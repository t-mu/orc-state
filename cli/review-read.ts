#!/usr/bin/env node
/**
 * cli/review-read.ts
 * Usage: orc review-read --run-id=<id> [--json]
 *
 * Retrieves all review_submitted events for a run, deduplicated by agent_id
 * (latest submission wins). In a registered project the running coordinator
 * serves them, so a sandboxed worker without write access can read them.
 * Exits 0 whatever the reviews say — the worker decides whether to proceed.
 */
import { STATE_DIR } from '../lib/paths.ts';
import { boolFlag, flag } from '../lib/args.ts';
import { readRunReviews } from '../lib/reviewRead.ts';
import { readProjectState } from '../lib/projectReads.ts';
import { cliError } from './shared.ts';

const runId = flag('run-id');
const asJson = boolFlag('json');

if (!runId) {
  console.error('--run-id is required');
  process.exit(1);
}

let reviews;
try {
  reviews = await readProjectState(
    async (client) => (await client.reviews(runId)).reviews,
    () => readRunReviews(STATE_DIR, runId),
  );
} catch (error) {
  cliError(error);
}

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
