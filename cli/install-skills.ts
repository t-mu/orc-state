#!/usr/bin/env node
/**
 * cli/install-skills.ts
 * Usage:
 *   orc install-skills [--provider=claude,codex,gemini] [--global] [--dry-run]
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
import { isMainModule } from './orc.ts';

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

function shouldSkipSkillEntry(skillName: string, relativePath: string): boolean {
  return relativePath === '.npmignore' || (skillName === 'spec' && relativePath === 'evals');
}

function copyDir(src: string, dest: string, dryRun: boolean, skillName: string, relativeRoot = ''): Array<{ src: string; dest: string }> {
  const entries = readdirSync(src, { withFileTypes: true });
  const copied: Array<{ src: string; dest: string }> = [];
  for (const entry of entries) {
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (shouldSkipSkillEntry(skillName, relativePath)) continue;
    const srcPath  = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      if (!dryRun) mkdirSync(destPath, { recursive: true });
      copied.push(...copyDir(srcPath, destPath, dryRun, skillName, relativePath));
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

export interface InstallResult {
  copied: string[];
  count: number;
}

export function installSkills(providers: string[], base: string, dryRun: boolean): InstallResult {
  const unknown = providers.filter((p) => p !== 'gemini' && !PROVIDER_TARGETS[p]);
  if (unknown.length > 0) {
    console.error(`Unknown provider(s): ${unknown.join(', ')}. Supported: ${[...Object.keys(PROVIDER_TARGETS), 'gemini'].join(', ')}`);
    process.exit(1);
  }

  const supportedProviders = providers.filter((provider) => provider in PROVIDER_TARGETS);
  const skippedProviders = providers.filter((provider) => provider === 'gemini');

  if (!existsSync(SKILLS_ROOT)) {
    console.error(`Skills directory not found: ${SKILLS_ROOT}`);
    process.exit(1);
  }

  if (dryRun) console.log('Dry run — no files will be written.\n');

  const skillEntries = readdirSync(SKILLS_ROOT, { withFileTypes: true });
  const skills = skillEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(SKILLS_ROOT, name, 'SKILL.md')));

  if (skills.length === 0) {
    console.log('No skills found in skills/ directory.');
    return { copied: [], count: 0 };
  }

  if (skippedProviders.length > 0) {
    console.warn(`Skipping skill installation for unsupported provider target(s): ${skippedProviders.join(', ')}.`);
  }

  const allCopied: string[] = [];

  for (const provider of supportedProviders) {
    const destBase = PROVIDER_TARGETS[provider](base);
    console.log(`${provider} → ${destBase}`);

    for (const skill of skills) {
      const src    = join(SKILLS_ROOT, skill);
      const dest   = join(destBase, skill);
      const copied = copyDir(src, dest, dryRun, skill);
      for (const { dest: d } of copied) {
        console.log(`  ${dryRun ? '(would copy) ' : ''}${relative(base, d)}`);
        allCopied.push(d);
      }
    }
  }

  console.log(`\n${dryRun ? 'Would install' : 'Installed'} ${allCopied.length} file(s).`);
  return { copied: allCopied, count: allCopied.length };
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const { isGlobal, isDryRun, providers } = parseArgs();
  const base = isGlobal ? homedir() : resolve('.');
  installSkills(providers, base, isDryRun);
}
