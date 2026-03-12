#!/usr/bin/env node
/**
 * cli/install-skills.mjs
 * Usage:
 *   orc install-skills [--provider=claude,codex] [--global] [--dry-run]
 *
 * Copies skills from the package's skills/<provider>/ directory into the
 * consumer's tool directories:
 *   claude  →  <target>/.claude/skills/<name>/
 *   codex   →  <target>/.codex/rules/
 *
 * --global   installs to ~/  instead of cwd
 * --dry-run  prints what would be copied without writing anything
 */
import { readdirSync, mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SKILLS_ROOT = resolve(fileURLToPath(import.meta.url), '../../skills');

const PROVIDER_TARGETS = {
  claude: (base) => join(base, '.claude', 'skills'),
  codex:  (base) => join(base, '.codex', 'rules'),
};

function parseArgs() {
  const args = process.argv.slice(2);
  const isGlobal  = args.includes('--global');
  const isDryRun  = args.includes('--dry-run');
  const providers = args.find((a) => a.startsWith('--provider='))
    ?.slice('--provider='.length)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    ?? Object.keys(PROVIDER_TARGETS);
  return { isGlobal, isDryRun, providers };
}

function copyDir(src, dest, dryRun) {
  const entries = readdirSync(src, { withFileTypes: true });
  const copied = [];
  for (const entry of entries) {
    const srcPath  = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      if (!dryRun) mkdirSync(destPath, { recursive: true });
      copied.push(...copyDir(srcPath, destPath, dryRun));
    } else {
      copied.push({ src: srcPath, dest: destPath });
      if (!dryRun) {
        mkdirSync(dest, { recursive: true });
        copyFileSync(srcPath, destPath);
      }
    }
  }
  return copied;
}

const { isGlobal, isDryRun, providers } = parseArgs();
const base = isGlobal ? homedir() : resolve('.');

const unknown = providers.filter((p) => !PROVIDER_TARGETS[p]);
if (unknown.length > 0) {
  console.error(`Unknown provider(s): ${unknown.join(', ')}. Supported: ${Object.keys(PROVIDER_TARGETS).join(', ')}`);
  process.exit(1);
}

if (!existsSync(SKILLS_ROOT)) {
  console.error(`Skills directory not found: ${SKILLS_ROOT}`);
  process.exit(1);
}

if (isDryRun) console.log('Dry run — no files will be written.\n');

let totalCopied = 0;

for (const provider of providers) {
  const providerSrc = join(SKILLS_ROOT, provider);
  if (!existsSync(providerSrc)) {
    console.log(`  ${provider}: no skills found (${providerSrc} missing), skipping`);
    continue;
  }

  const destBase = PROVIDER_TARGETS[provider](base);
  const entries  = readdirSync(providerSrc, { withFileTypes: true });
  const skills   = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  if (skills.length === 0) {
    console.log(`  ${provider}: directory exists but contains no skill subdirectories`);
    continue;
  }

  console.log(`${provider} → ${destBase}`);

  for (const skill of skills) {
    const src    = join(providerSrc, skill);
    const dest   = join(destBase, skill);
    const copied = copyDir(src, dest, isDryRun);
    for (const { dest: d } of copied) {
      console.log(`  ${isDryRun ? '(would copy) ' : ''}${relative(base, d)}`);
    }
    totalCopied += copied.length;
  }
}

console.log(`\n${isDryRun ? 'Would install' : 'Installed'} ${totalCopied} file(s).`);
