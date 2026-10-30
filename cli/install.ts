#!/usr/bin/env node
/**
 * cli/install.ts
 * Usage:
 *   orc install [--provider=claude,codex,gemini] [--global] [--dry-run]
 *               [--skip-skills] [--skip-agents]
 *
 * Copies orc's skills and agents for the given providers. If --provider is not
 * passed, it uses the active project's provider settings. orc start-session
 * wires the orchestrator MCP server itself, so install writes no MCP config.
 *
 * --global       installs to ~/  instead of cwd
 * --dry-run      prints what would happen without writing anything
 * --skip-skills  skip skill installation
 * --skip-agents  skip agent installation
 */
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { installSkills } from './install-skills.ts';
import { installAgents } from './install-agents.ts';
import { ProjectRegistry } from '../lib/projectRegistry.ts';
import { isMainModule } from './orc.ts';

export interface InstallOptions {
  providers: string[];
  base: string;
  dryRun: boolean;
  skipSkills: boolean;
  skipAgents: boolean;
}

/** The providers a project's settings name (default, master and worker pool). */
export function detectProviders(projectId: string, registry: ProjectRegistry = new ProjectRegistry()): string[] {
  let settings: Record<string, unknown>;
  try {
    settings = registry.effectiveSettings(projectId);
  } finally {
    registry.close();
  }
  const providers = new Set<string>();
  for (const key of ['default_provider', 'master.provider', 'worker_pool.provider']) {
    if (typeof settings[key] === 'string') providers.add(settings[key]);
  }
  return [...providers];
}

export function runInstall(options: InstallOptions): void {
  const { providers, base, dryRun, skipSkills, skipAgents } = options;

  let skillsCount = 0;
  let agentsCount = 0;

  if (!skipSkills) {
    const result = installSkills(providers, base, dryRun);
    skillsCount = result.count;
  } else {
    console.log('Skipping skill installation.');
  }

  if (!skipAgents) {
    const result = installAgents(providers, base, dryRun);
    agentsCount = result.count;
  } else {
    console.log('Skipping agent installation.');
  }

  console.log(`\n${dryRun ? 'Dry run complete.' : 'Install complete.'} skills=${skillsCount} agents=${agentsCount}`);
}

async function parseArgs(): Promise<InstallOptions> {
  const args = process.argv.slice(2);
  const isGlobal  = args.includes('--global');
  const dryRun    = args.includes('--dry-run');
  const skipSkills = args.includes('--skip-skills');
  const skipAgents = args.includes('--skip-agents');

  const base = isGlobal ? homedir() : resolve('.');

  const providerArg = args.find((a) => a.startsWith('--provider='));
  let providers: string[];
  if (providerArg) {
    providers = providerArg
      .slice('--provider='.length)
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  } else {
    const { ACTIVE_PROJECT } = await import('../lib/paths.ts');
    providers = ACTIVE_PROJECT ? detectProviders(ACTIVE_PROJECT.id) : [];
    if (providers.length === 0) {
      console.error(
        'Error: no --provider specified and no provider set for the active project (orc init records it).\n' +
        'Run: orc install --provider=claude  (or codex, gemini)',
      );
      process.exit(1);
    }
    console.log(`Autodetected provider(s): ${providers.join(', ')}`);
  }

  return { providers, base, dryRun, skipSkills, skipAgents };
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const options = await parseArgs();
  runInstall(options);
}
