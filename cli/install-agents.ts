#!/usr/bin/env node
/**
 * cli/install-agents.ts
 * Usage:
 *   orc install-agents [--provider=claude,codex] [--global] [--dry-run]
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

const { isGlobal, isDryRun, providers } = parseArgs();
const base = isGlobal ? homedir() : resolve('.');

const unknown = providers.filter((p) => !PROVIDER_TARGETS[p]);
if (unknown.length > 0) {
  console.error(`Unknown provider(s): ${unknown.join(', ')}. Supported: ${Object.keys(PROVIDER_TARGETS).join(', ')}`);
  process.exit(1);
}

if (!existsSync(AGENTS_ROOT)) {
  console.error(`Agents directory not found: ${AGENTS_ROOT}`);
  process.exit(1);
}

if (isDryRun) console.log('Dry run — no files will be written.\n');

const agentEntries = readdirSync(AGENTS_ROOT, { withFileTypes: true });
const agentFiles = agentEntries.filter((e) => e.isFile()).map((e) => e.name);

if (agentFiles.length === 0) {
  console.log('No agents found in agents/ directory.');
  process.exit(0);
}

let totalCopied = 0;

for (const provider of providers) {
  const destBase = PROVIDER_TARGETS[provider](base);
  console.log(`${provider} → ${destBase}`);

  for (const agentFile of agentFiles) {
    const src = join(AGENTS_ROOT, agentFile);
    const dest = join(destBase, agentFile);
    if (!isDryRun) {
      mkdirSync(destBase, { recursive: true });
      copyFileSync(src, dest);
    }
    console.log(`  ${isDryRun ? '(would copy) ' : ''}${relative(base, dest)}`);
    totalCopied += 1;
  }
}

console.log(`\n${isDryRun ? 'Would install' : 'Installed'} ${totalCopied} file(s).`);
