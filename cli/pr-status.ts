#!/usr/bin/env node
/**
 * cli/pr-status.ts
 * Usage: orc pr-status <pr_ref> [--wait]
 *
 * Prints PR status. With --wait, blocks until CI resolves and prints "passing" or "failing".
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ORC_CONFIG_FILE } from '../lib/paths.ts';
import { getGitHostAdapter } from '../lib/gitHosts/index.ts';
import { boolFlag } from '../lib/args.ts';

export function run(argv: string[] = process.argv.slice(2), configFile: string = ORC_CONFIG_FILE): void {
  const prRef = argv.find((a) => !a.startsWith('--'));
  if (!prRef) {
    console.error('Usage: orc pr-status <pr_ref> [--wait]');
    process.exit(1);
  }

  const wait = boolFlag('wait', argv);

  const rawConfig = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown> : {};
  const prProvider = typeof rawConfig.pr_provider === 'string' ? rawConfig.pr_provider : null;
  if (!prProvider) {
    console.error('pr_provider not configured');
    process.exit(1);
  }

  const adapter = getGitHostAdapter(prProvider);

  if (wait) {
    const ciResult = adapter.waitForCi(prRef);
    console.log(ciResult);
  } else {
    const status = adapter.checkPrStatus(prRef);
    console.log(status);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run();
}
