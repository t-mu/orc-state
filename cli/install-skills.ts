#!/usr/bin/env node
/**
 * cli/install-skills.ts
 * Usage:
 *   orc install-skills [--provider=claude,codex] [--global] [--dry-run]
 *
 * Copies skills from the package's skills/ directory into the consumer's
 * tool directories for each selected provider:
 *   claude  →  <target>/.claude/skills/<name>/
 *   codex   →  <target>/.codex/skills/<name>/
 *
 * Skills are provider-agnostic — the same files are installed for all
 * selected providers. Use --provider= to restrict which providers are targeted.
 *
 * --global   installs to ~/  instead of cwd
 * --dry-run  prints what would be copied without writing anything
 */
import { readdirSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SKILLS_ROOT = resolve(fileURLToPath(import.meta.url), '../../skills');

const PROVIDER_TARGETS: Record<string, (base: string) => string> = {
  claude: (base) => join(base, '.claude', 'skills'),
  codex:  (base) => join(base, '.codex', 'skills'),
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

function copyDir(src: string, dest: string, dryRun: boolean): Array<{ src: string; dest: string }> {
  const entries = readdirSync(src, { withFileTypes: true });
  const copied: Array<{ src: string; dest: string }> = [];
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

const skillEntries = readdirSync(SKILLS_ROOT, { withFileTypes: true });
const skills = skillEntries.filter((e) => e.isDirectory()).map((e) => e.name);

if (skills.length === 0) {
  console.log('No skills found in skills/ directory.');
  process.exit(0);
}

let totalCopied = 0;

for (const provider of providers) {
  const destBase = PROVIDER_TARGETS[provider](base);
  console.log(`${provider} → ${destBase}`);

  for (const skill of skills) {
    const src    = join(SKILLS_ROOT, skill);
    const dest   = join(destBase, skill);
    const copied = copyDir(src, dest, isDryRun);
    for (const { dest: d } of copied) {
      console.log(`  ${isDryRun ? '(would copy) ' : ''}${relative(base, d)}`);
    }
    totalCopied += copied.length;
  }
}

console.log(`\n${isDryRun ? 'Would install' : 'Installed'} ${totalCopied} file(s).`);
