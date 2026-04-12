#!/usr/bin/env node
/**
 * cli/pr-merge.ts
 * Usage: orc pr-merge <pr_ref>
 *
 * Merges a PR using the configured git host adapter.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ORC_CONFIG_FILE } from '../lib/paths.ts';
import { getGitHostAdapter } from '../lib/gitHosts/index.ts';

export function run(argv: string[] = process.argv.slice(2), configFile: string = ORC_CONFIG_FILE): void {
  const prRef = argv.find((a) => !a.startsWith('--'));
  if (!prRef) {
    console.error('Usage: orc pr-merge <pr_ref>');
    process.exit(1);
  }

  const rawConfig = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown> : {};
  const coordinator = (rawConfig.coordinator ?? {}) as Record<string, unknown>;
  const prProvider = typeof coordinator.pr_provider === 'string' ? coordinator.pr_provider : null;
  if (!prProvider) {
    console.error('pr_provider not configured');
    process.exit(1);
  }

  const adapter = getGitHostAdapter(prProvider);
  adapter.mergePr(prRef);
  console.log(`Merged PR ${prRef}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run();
}
