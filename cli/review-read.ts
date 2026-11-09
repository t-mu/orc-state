#!/usr/bin/env node
/**
 * cli/review-read.ts
 * Usage: orc review-read --run-id=<id> [--json]
 *
 * Retrieves all review_submitted events for a run, deduplicated per reviewer
 * (agent_id + --reviewer label; latest submission wins). In a registered project the running coordinator
 * serves them, so a sandboxed worker without write access can read them.
 * Exits 0 whatever the reviews say — the worker decides whether to proceed;
 * exits 1 only when the reviews could not be read (retry later).
 */
import { STATE_DIR } from '../lib/paths.ts';
import { parseCommandArgsOrExit } from '../lib/args.ts';
import { readRunReviews, readViaCoordinator } from '../lib/projectReads.ts';
import { cliError, exitAfterFlush, printJson } from './shared.ts';
import { USAGE } from './usage.ts';

const { values } = parseCommandArgsOrExit(USAGE['review-read'], { 'run-id': { type: 'string' }, json: { type: 'boolean' } });
const runId = values['run-id'];
const asJson = values.json === true;

if (!runId) {
  console.error('--run-id is required');
  process.exit(1);
}

let reviews;
try {
  reviews = await readViaCoordinator(
    async (client) => (await client.reviews(runId)).reviews,
    () => readRunReviews(STATE_DIR, runId),
  );
} catch (error) {
  cliError(error);
}

if (asJson) {
  printJson({ count: reviews.length, reviews });
  await exitAfterFlush(0);
}

if (reviews.length === 0) {
  console.log(`No reviews found for run ${runId}`);
  process.exit(0);
}

for (const r of reviews) {
  console.log(`\n--- Review from ${r.agent_id}${r.payload.reviewer ? ` (${r.payload.reviewer})` : ''} [${r.payload.outcome}] ---`);
  console.log(r.payload.findings);
}
