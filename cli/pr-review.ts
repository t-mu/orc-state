#!/usr/bin/env node
/**
 * cli/pr-review.ts
 * Usage: orc pr-review <pr_ref> --approve|--request-changes --body="..."
 *
 * Submits a review on a PR using the configured git host adapter.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ORC_CONFIG_FILE } from '../lib/paths.ts';
import { getGitHostAdapter } from '../lib/gitHosts/index.ts';
import { boolFlag, flag } from '../lib/args.ts';

export function run(argv: string[] = process.argv.slice(2), configFile: string = ORC_CONFIG_FILE): void {
  const prRef = argv.find((a) => !a.startsWith('--'));
  if (!prRef) {
    console.error('Usage: orc pr-review <pr_ref> --approve|--request-changes --body="..."');
    process.exit(1);
  }

  const approve = boolFlag('approve', argv);
  const requestChanges = boolFlag('request-changes', argv);
  const body = flag('body', argv) ?? '';

  if (!approve && !requestChanges) {
    console.error('Usage: orc pr-review <pr_ref> --approve|--request-changes --body="..."');
    process.exit(1);
  }

  const rawConfig = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown> : {};
  const prProvider = typeof rawConfig.pr_provider === 'string' ? rawConfig.pr_provider : null;
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
