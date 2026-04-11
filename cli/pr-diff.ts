#!/usr/bin/env node
/**
 * cli/pr-diff.ts
 * Usage: orc pr-diff <pr_ref>
 *
 * Prints the diff for a PR to stdout using the configured git host adapter.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ORC_CONFIG_FILE } from '../lib/paths.ts';
import { getGitHostAdapter } from '../lib/gitHosts/index.ts';

export function run(argv: string[] = process.argv.slice(2), configFile: string = ORC_CONFIG_FILE): void {
  const prRef = argv[0];
  if (!prRef) {
    console.error('Usage: orc pr-diff <pr_ref>');
    process.exit(1);
  }

  const rawConfig = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown> : {};
  const prProvider = typeof rawConfig.pr_provider === 'string' ? rawConfig.pr_provider : null;
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
