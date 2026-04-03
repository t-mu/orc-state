#!/usr/bin/env node
/**
 * cli/install-agents.ts
 * Usage:
 *   orc install-agents [--provider=claude,codex,gemini] [--global] [--dry-run]
 *
 * Copies agents from the package's agents/ directory into the consumer's
 * tool directories for each selected provider:
 *   claude  →  <target>/.claude/agents/<name>/
 *   codex   →  <target>/.codex/agents/<name>/
 *
 * Agent prompts are provider-agnostic — the same files are installed for all
 * selected providers. Use --provider= to restrict which providers are targeted.
 *
 * --global   installs to ~/  instead of cwd
 * --dry-run  prints what would be copied without writing anything
 */
import { readdirSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './orc.ts';

const AGENTS_ROOT = resolve(fileURLToPath(import.meta.url), '../../agents');

const PROVIDER_TARGETS: Record<string, (base: string) => string> = {
  claude: (base) => join(base, '.claude', 'agents'),
  codex:  (base) => join(base, '.codex', 'agents'),
};

function parseArgs() {
  const args = process.argv.slice(2);
  const isGlobal = args.includes('--global');
  const isDryRun = args.includes('--dry-run');
  const providers = args.find((a) => a.startsWith('--provider='))
    ?.slice('--provider='.length)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    ?? Object.keys(PROVIDER_TARGETS);
  return { isGlobal, isDryRun, providers };
}

export interface InstallResult {
  copied: string[];
  count: number;
}

export function installAgents(providers: string[], base: string, dryRun: boolean): InstallResult {
  const unknown = providers.filter((p) => p !== 'gemini' && !PROVIDER_TARGETS[p]);
  if (unknown.length > 0) {
    console.error(`Unknown provider(s): ${unknown.join(', ')}. Supported: ${[...Object.keys(PROVIDER_TARGETS), 'gemini'].join(', ')}`);
    process.exit(1);
  }

  const supportedProviders = providers.filter((provider) => provider in PROVIDER_TARGETS);
  const skippedProviders = providers.filter((provider) => provider === 'gemini');

  if (!existsSync(AGENTS_ROOT)) {
    console.error(`Agents directory not found: ${AGENTS_ROOT}`);
    process.exit(1);
  }

  if (dryRun) console.log('Dry run — no files will be written.\n');

  const agentEntries = readdirSync(AGENTS_ROOT, { withFileTypes: true });
  const agentFiles = agentEntries.filter((e) => e.isFile()).map((e) => e.name);

  if (agentFiles.length === 0) {
    console.log('No agents found in agents/ directory.');
    return { copied: [], count: 0 };
  }

  if (skippedProviders.length > 0) {
    console.warn(`Skipping agent installation for unsupported provider target(s): ${skippedProviders.join(', ')}.`);
  }

  const allCopied: string[] = [];

  for (const provider of supportedProviders) {
    const destBase = PROVIDER_TARGETS[provider](base);
    console.log(`${provider} → ${destBase}`);

    for (const agentFile of agentFiles) {
      const src = join(AGENTS_ROOT, agentFile);
      const dest = join(destBase, agentFile);
      if (!dryRun) {
        mkdirSync(destBase, { recursive: true });
        copyFileSync(src, dest);
      }
      console.log(`  ${dryRun ? '(would copy) ' : ''}${relative(base, dest)}`);
      allCopied.push(dest);
    }
  }

  console.log(`\n${dryRun ? 'Would install' : 'Installed'} ${allCopied.length} file(s).`);
  return { copied: allCopied, count: allCopied.length };
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const { isGlobal, isDryRun, providers } = parseArgs();
  const base = isGlobal ? homedir() : resolve('.');
  installAgents(providers, base, isDryRun);
}
