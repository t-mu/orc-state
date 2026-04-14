#!/usr/bin/env node
/**
 * cli/init.ts
 * Usage:
 *   orc init [--provider=claude,codex,gemini] [--worker-provider=<name>]
 *            [--skip-skills] [--skip-agents] [--skip-mcp]
 *            [--feature=<ref>] [--feature-title=<title>] [--force]
 *
 * Interactive first-time setup: provider selection, state initialization,
 * skills/agents/MCP installation.
 *
 * In a TTY (without --provider):
 *   Prompts for provider(s), skills, agents, and MCP installation.
 *
 * Non-TTY / with --provider flag:
 *   --provider=claude,codex,gemini  required in non-TTY environments
 *   --skip-skills            skip skill installation
 *   --skip-agents            skip agent installation
 *   --skip-mcp               skip MCP config merge
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { STATE_DIR, BACKLOG_DOCS_DIR } from '../lib/paths.ts';
import { boolFlag, flag } from '../lib/args.ts';
import { validateStateDir } from '../lib/stateValidation.ts';
import { ensureGitignore } from '../lib/gitignore.ts';
import { ensureStateInitialized } from '../lib/stateInit.ts';
import { runInstall } from './install.ts';
import { cliError } from './shared.ts';
import { isBinaryAvailable, PROVIDER_BINARIES } from '../lib/binaryCheck.ts';

const force = boolFlag('force');
const featureRef = flag('feature') ?? 'project';
const featureTitle = flag('feature-title') ?? 'Project';
const providerFlag = flag('provider');
const stateFiles = ['backlog.json', 'agents.json', 'claims.json', 'events.db'];

// Validate git repo before anything else
try {
  execSync('git rev-parse --git-dir', { stdio: 'pipe' });
} catch {
  cliError('Must run inside a git repository. Run `git init` first.');
}

ensureGitignore();
mkdirSync(BACKLOG_DOCS_DIR, { recursive: true });

// Step 1: State initialization (idempotent)
const existing = stateFiles.filter((name) => existsSync(join(STATE_DIR, name)));
const stateExists = existing.length > 0;

if (stateExists && !force) {
  console.log('State directory already exists, skipping initialization.');
} else {
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
}

// Step 2: Provider and install option selection
let providers: string[];
let workerProvider: string | null = null;
let skipSkills: boolean;
let skipAgents: boolean;
let skipMcp: boolean;

const isTTY = Boolean(process.stdin.isTTY);
const workerProviderFlag = flag('worker-provider');

if (providerFlag) {
  providers = providerFlag.split(',').map((p) => p.trim()).filter(Boolean);
  if (workerProviderFlag) {
    if (!providers.includes(workerProviderFlag)) {
      console.error(`Error: --worker-provider '${workerProviderFlag}' is not in the selected providers: ${providers.join(', ')}`);
      process.exit(1);
    }
    workerProvider = workerProviderFlag;
  } else {
    workerProvider = providers.length > 1 ? providers[1] : null;
  }
  skipSkills = boolFlag('skip-skills');
  skipAgents = boolFlag('skip-agents');
  skipMcp = boolFlag('skip-mcp');
} else if (isTTY) {
  const { checkbox, confirm, select } = await import('@inquirer/prompts');

  providers = await checkbox({
    message: 'Which provider(s) will you use?',
    choices: [
      { name: 'Claude', value: 'claude', checked: true },
      { name: 'Codex', value: 'codex', checked: true },
      { name: 'Gemini (skills/agents skipped)', value: 'gemini', checked: false },
    ],
  });

  if (providers.length === 0) {
    console.error('At least one provider must be selected.');
    process.exit(1);
  }

  workerProvider = await select({
    message: 'Choose default provider for worker agents:',
    choices: providers.map((p) => ({ name: p, value: p })),
    default: providers.length > 1 ? providers[1] : providers[0],
  });

  const installSkills = await confirm({ message: 'Install skills? (recommended)', default: true });
  const installAgents = await confirm({ message: 'Install agents? (recommended)', default: true });
  const installMcp = await confirm({ message: 'Configure MCP? (recommended)', default: true });

  skipSkills = !installSkills;
  skipAgents = !installAgents;
  skipMcp = !installMcp;
} else {
  console.error('Error: --provider is required in non-TTY environments.');
  console.error('Example: orc init --provider=claude');
  process.exit(1);
}

// Validate provider binaries (warn only — do not block init)
for (const provider of providers) {
  const binary = PROVIDER_BINARIES[provider] ?? provider;
  if (!isBinaryAvailable(binary)) {
    console.warn(`⚠️  Warning: '${provider}' binary not found on PATH. Install it before running orc start-session.`);
  }
}

// Step 3: Write orc-state.config.json
const config: Record<string, unknown> = {};
config.default_provider = providers[0];
const pool: Record<string, unknown> = { max_workers: 1 };
if (workerProvider) {
  pool.provider = workerProvider;
}
config.worker_pool = pool;
writeFileSync('orc-state.config.json', JSON.stringify(config, null, 2) + '\n', 'utf8');

// Step 4: Run install
runInstall({
  providers,
  base: process.cwd(),
  dryRun: false,
  skipSkills,
  skipAgents,
  skipMcp,
});

// Step 5: Print success summary
console.log('');
console.log('Setup complete!');
console.log('');
console.log('Next steps:');
console.log('  orc start-session');
console.log(`  orc task-create --feature=${featureRef} --title="First task" --ac="Done"`);
console.log('  orc delegate');
