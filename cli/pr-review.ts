#!/usr/bin/env node
/**
 * cli/pr-review.ts
 * Usage: orc pr-review <pr_ref> --approve|--request-changes --body="..."
 *
 * Submits a review on a PR using the configured git host adapter.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { storedSettings, type OrcSettings } from '../lib/providers.ts';
import { getGitHostAdapter } from '../lib/gitHosts/index.ts';
import { boolFlag, flag } from '../lib/args.ts';
import { USAGE } from './usage.ts';

export function run(argv: string[] = process.argv.slice(2), settings: OrcSettings = storedSettings()): void {
  const prRef = argv.find((a) => !a.startsWith('--'));
  if (!prRef) {
    console.error(`Usage: ${USAGE['pr-review']}`);
    process.exit(1);
  }

  const approve = boolFlag('approve', argv);
  const requestChanges = boolFlag('request-changes', argv);
  const body = flag('body', argv) ?? '';

  if (!approve && !requestChanges) {
    console.error(`Usage: ${USAGE['pr-review']}`);
    process.exit(1);
  }

  const coordinator = (settings.coordinator ?? {}) as Record<string, unknown>;
  const prProvider = typeof coordinator.pr_provider === 'string' ? coordinator.pr_provider : null;
  if (!prProvider) {
    console.error('pr_provider not configured');
    process.exit(1);
  }

  const adapter = getGitHostAdapter(prProvider);
  adapter.submitReview(prRef, body, approve);
  console.log(`Review submitted for ${prRef}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run();
}
