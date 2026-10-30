#!/usr/bin/env node
/**
 * cli/init.ts
 * Usage:
 *   orc init [--provider=claude,codex,gemini] [--worker-provider=<name>]
 *
 * Configure the registered project: provider selection is recorded in the
 * project registry and the external state directory is completed. Nothing is
 * written into the target repository. Register a repository first with
 * `orc project add <git-path>` (or migrate a legacy installation with
 * `orc project migrate`).
 *
 * In a TTY (without --provider) it prompts for the provider(s); elsewhere
 * --provider is required.
 */
import { ACTIVE_PROJECT, STATE_DIR, assertProjectMode } from '../lib/paths.ts';
import { ProjectRegistry } from '../lib/projectRegistry.ts';
import { initProjectTaskStore } from '../lib/projectTasks.ts';
import { boolFlag, flag } from '../lib/args.ts';
import { ensureStateInitialized } from '../lib/stateInit.ts';
import { cliError } from './shared.ts';
import { isBinaryAvailable, PROVIDER_BINARIES } from '../lib/binaryCheck.ts';

// The sibling layout is retired; a separate target repository is a registered project.
if (flag('sibling') !== null) {
  cliError('orc init --sibling is retired. Register the target repository as a project instead: orc project add <target-repo-path> (migrate an existing sibling home with orc project migrate).');
}

try {
  assertProjectMode();
} catch (error) {
  cliError((error as Error).message);
}
const project = ACTIVE_PROJECT!;

if (boolFlag('force')) {
  cliError(`orc init --force would reset the live state of project ${project.name}; reset tasks with orc task-reset instead.`);
}

// init installs nothing into the repository; these legacy options do not apply.
const ignored = ['skip-skills', 'skip-agents', 'skip-mcp', 'feature', 'feature-title'].filter((name) => flag(name) !== null || boolFlag(name));
if (ignored.length > 0) console.warn(`Note: ${ignored.map((name) => `--${name}`).join(', ')} has no effect in a registered project.`);

ensureStateInitialized(STATE_DIR);
initProjectTaskStore(STATE_DIR);

let providers: string[];
let workerProvider: string | null = null;
const providerFlag = flag('provider');
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
} else if (process.stdin.isTTY) {
  const { checkbox, select } = await import('@inquirer/prompts');

  providers = await checkbox({
    message: 'Which provider(s) will you use?',
    choices: [
      { name: 'Claude', value: 'claude', checked: true },
      { name: 'Codex', value: 'codex', checked: true },
      { name: 'Gemini', value: 'gemini', checked: false },
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

// Settings go to the registry; nothing is written into the target repository.
const registry = new ProjectRegistry();
try {
  registry.setSetting('default_provider', providers[0], project.id);
  if (workerProvider) registry.setSetting('worker_pool.provider', workerProvider, project.id);
  if (!('worker_pool.max_workers' in registry.effectiveSettings(project.id))) registry.setSetting('worker_pool.max_workers', 1, project.id);
} finally {
  registry.close();
}
console.log('');
console.log(`Project ${project.name} (${project.id}) configured; settings are in the project registry (orc project config list).`);
console.log('Nothing was written into the target repository. orc start-session wires the orchestrator MCP server;');
console.log(`install skills and agents for your user with: orc install --global --skip-mcp --provider=${providers.join(',')}`);
console.log('');
console.log('Next steps:');
console.log('  orc start-session');
console.log('  orc project task create --feature=project --title="First task" --ac="Done"');
