#!/usr/bin/env node
/**
 * cli/init.ts
 * Usage:
 *   node cli/init.ts [--feature=<ref>] [--feature-title=<title>] [--force]
 */
import { existsSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../lib/paths.ts';
import { flag } from '../lib/args.ts';
import { validateStateDir } from '../lib/stateValidation.ts';
import { ensureGitignore } from '../lib/gitignore.ts';
import { ensureStateInitialized } from '../lib/stateInit.ts';

const force = process.argv.includes('--force') || (flag('force') ?? '') === 'true';
const featureRef = flag('feature') ?? 'project';
const featureTitle = flag('feature-title') ?? 'Project';
const stateFiles = ['backlog.json', 'agents.json', 'claims.json', 'events.db'];

ensureGitignore();

const existing = stateFiles.filter((name) => existsSync(join(STATE_DIR, name)));
if (existing.length > 0 && !force) {
  console.error(`State directory already contains files: ${existing.join(', ')}`);
  console.error('Use --force to overwrite.');
  process.exit(1);
}

if (force) {
  for (const file of existing) {
    copyFileSync(join(STATE_DIR, file), join(STATE_DIR, `${file}.bak`));
    console.log(`backed up ${file} -> ${file}.bak`);
  }
  for (const file of existing) {
    try { unlinkSync(join(STATE_DIR, file)); } catch { /* already gone */ }
  }
}

ensureStateInitialized(STATE_DIR);
writeFileSync(
  join(STATE_DIR, 'backlog.json'),
  JSON.stringify({ version: '1', features: [{ ref: featureRef, title: featureTitle, tasks: [] }] }, null, 2) + '\n',
  'utf8',
);

const errors = validateStateDir(STATE_DIR);
if (errors.length > 0) {
  console.error('ERROR: generated state files are invalid:');
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(`Initialized orchestrator state in: ${STATE_DIR}`);
console.log(`  backlog.json  - 1 feature ()`);
console.log('  agents.json   - 0 agents');
console.log('  claims.json   - 0 claims');
console.log('  events.db     - empty');
console.log('');
console.log('Next steps:');
console.log('  orc start-session');
console.log(`  orc task-create --feature=${featureRef} --title="First task" --ac="Done"`);
console.log(`  orc delegate --task-ref=/<slug>`);
console.log('  Debug only: orc-worker-register <id> --provider=<claude|codex|gemini>');
