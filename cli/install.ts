#!/usr/bin/env node
/**
 * cli/install.ts
 * Usage:
 *   orc install [--provider=claude,codex] [--global] [--dry-run]
 *               [--skip-skills] [--skip-agents] [--skip-mcp]
 *
 * Unified installer: copies skills, agents, and merges MCP config in one shot.
 * If --provider is not passed, autodetects from orchestrator.config.json.
 *
 * --global       installs to ~/  instead of cwd
 * --dry-run      prints what would happen without writing anything
 * --skip-skills  skip skill installation
 * --skip-agents  skip agent installation
 * --skip-mcp     skip MCP config merge
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { installSkills } from './install-skills.ts';
import { installAgents } from './install-agents.ts';
import { mergeMcpConfig, defaultServerPath } from '../lib/mcpConfig.ts';
import { isMainModule } from './orc.ts';

export interface InstallOptions {
  providers: string[];
  base: string;
  dryRun: boolean;
  skipSkills: boolean;
  skipAgents: boolean;
  skipMcp: boolean;
}

export function detectProviders(base: string): string[] {
  const configPath = join(base, 'orchestrator.config.json');
  if (!existsSync(configPath)) return [];
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return [];
  }
  const providers = new Set<string>();
  if (typeof config.default_provider === 'string') providers.add(config.default_provider);
  const master = config.master as Record<string, unknown> | undefined;
  if (typeof master?.provider === 'string') providers.add(master.provider);
  const workerPool = config.worker_pool as Record<string, unknown> | undefined;
  if (typeof workerPool?.provider === 'string') providers.add(workerPool.provider);
  return [...providers];
}

// Exported for programmatic use by cli/init.ts (Task 104)
export function runInstall(options: InstallOptions): void {
  const { providers, base, dryRun, skipSkills, skipAgents, skipMcp } = options;

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

  if (!skipMcp) {
    const serverPath = defaultServerPath();
    const stateDir = join(base, '.orc-state');
    const result = mergeMcpConfig(base, serverPath, stateDir, dryRun);
    if (dryRun) {
      console.log(`(would write) ${result.path}`);
    } else if (result.created) {
      console.log(`Created ${result.path}`);
    } else if (result.updated) {
      console.log(`Updated ${result.path}`);
    } else {
      console.log(`${result.path} already up to date.`);
    }
  } else {
    console.log('Skipping MCP config merge.');
  }

  console.log(`\n${dryRun ? 'Dry run complete.' : 'Install complete.'} skills=${skillsCount} agents=${agentsCount}`);
}

function parseArgs(): InstallOptions {
  const args = process.argv.slice(2);
  const isGlobal  = args.includes('--global');
  const dryRun    = args.includes('--dry-run');
  const skipSkills = args.includes('--skip-skills');
  const skipAgents = args.includes('--skip-agents');
  const skipMcp    = args.includes('--skip-mcp');

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
    providers = detectProviders(base);
    if (providers.length === 0) {
      console.error(
        'Error: no --provider specified and no provider found in orchestrator.config.json.\n' +
        'Run: orc install --provider=claude  (or codex)',
      );
      process.exit(1);
    }
    console.log(`Autodetected provider(s): ${providers.join(', ')}`);
  }

  return { providers, base, dryRun, skipSkills, skipAgents, skipMcp };
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const options = parseArgs();
  runInstall(options);
}
