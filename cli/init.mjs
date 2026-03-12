#!/usr/bin/env node
/**
 * cli/init.mjs
 * Usage:
 *   node cli/init.mjs [--epic=<ref>] [--epic-title=<title>] [--force]
 */
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../lib/paths.mjs';
import { flag } from '../lib/args.mjs';
import { validateStateDir } from '../lib/stateValidation.mjs';
import { ensureGitignore } from '../lib/gitignore.mjs';

const force = process.argv.includes('--force') || (flag('force') ?? '') === 'true';
const epicRef = flag('epic') ?? 'project';
const epicTitle = flag('epic-title') ?? 'Project';
const stateFiles = ['backlog.json', 'agents.json', 'claims.json', 'events.jsonl'];

mkdirSync(STATE_DIR, { recursive: true });
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
}

const backlog = {
  version: '1',
  epics: [{ ref: epicRef, title: epicTitle, tasks: [] }],
};
const agents = { version: '1', agents: [] };
const claims = { version: '1', claims: [] };

writeFileSync(join(STATE_DIR, 'backlog.json'), JSON.stringify(backlog, null, 2) + '\n', 'utf8');
writeFileSync(join(STATE_DIR, 'agents.json'), JSON.stringify(agents, null, 2) + '\n', 'utf8');
writeFileSync(join(STATE_DIR, 'claims.json'), JSON.stringify(claims, null, 2) + '\n', 'utf8');
writeFileSync(join(STATE_DIR, 'events.jsonl'), '', 'utf8');

const errors = validateStateDir(STATE_DIR);
if (errors.length > 0) {
  console.error('ERROR: generated state files are invalid:');
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(`Initialized orchestrator state in: ${STATE_DIR}`);
console.log(`  backlog.json  - 1 epic (${epicRef})`);
console.log('  agents.json   - 0 agents');
console.log('  claims.json   - 0 claims');
console.log('  events.jsonl  - empty');
console.log('');
console.log('Next steps:');
console.log('  orc start-session');
console.log(`  orc task-create --epic=${epicRef} --title="First task" --ac="Done"`);
console.log(`  orc delegate --task-ref=${epicRef}/<slug>`);
console.log('  Debug only: orc-worker-register <id> --provider=<claude|codex|gemini>');
