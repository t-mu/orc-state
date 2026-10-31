#!/usr/bin/env node
/**
 * cli/pr-diff.ts
 * Usage: orc pr-diff <pr_ref>
 *
 * Prints the diff for a PR to stdout using the configured git host adapter.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { storedSettings, type OrcSettings } from '../lib/providers.ts';
import { getGitHostAdapter } from '../lib/gitHosts/index.ts';

export function run(argv: string[] = process.argv.slice(2), settings: OrcSettings = storedSettings()): void {
  const prRef = argv.find((a) => !a.startsWith('--'));
  if (!prRef) {
    console.error('Usage: orc pr-diff <pr_ref>');
    process.exit(1);
  }

  const coordinator = (settings.coordinator ?? {}) as Record<string, unknown>;
  const prProvider = typeof coordinator.pr_provider === 'string' ? coordinator.pr_provider : null;
  if (!prProvider) {
    console.error('pr_provider not configured');
    process.exit(1);
  }

  const adapter = getGitHostAdapter(prProvider);
  process.stdout.write(adapter.getPrDiff(prRef));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run();
}
