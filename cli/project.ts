#!/usr/bin/env node
/** Global project registry commands; these do not need an orc repository. */
import { ProjectRegistry } from '../lib/projectRegistry.ts';
import { isMainModule } from './orc.ts';

function option(args: string[], name: string): string | undefined {
  const prefixed = args.find((arg) => arg.startsWith(`--${name}=`));
  return prefixed?.slice(name.length + 3);
}

function positionals(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith('--'));
}

function usage(): never {
  throw new Error('Usage: orc project add <git-path> [--name=N] | list | select <id> | show [--project=id] | config <list|get|set|unset> [key] [value] [--global] [--project=id]');
}

export function runProjectCommand(args: string[], registry: ProjectRegistry, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): unknown {
  const [action, ...rest] = args;
  const values = positionals(rest);
  const projectFlag = option(rest, 'project');
  if (action === 'add') {
    if (values.length !== 1 || rest.some((arg) => arg.startsWith('--') && !arg.startsWith('--name='))) usage();
    return registry.add(values[0], option(rest, 'name'));
  }
  if (action === 'list') {
    if (values.length || rest.length) usage();
    return registry.list();
  }
  if (action === 'select') {
    if (values.length !== 1 || rest.length !== 1) usage();
    return registry.select(values[0]);
  }
  if (action === 'show') {
    if (values.length || rest.some((arg) => !arg.startsWith('--project='))) usage();
    return registry.resolve({ explicitProjectId: projectFlag ?? null, env, cwd });
  }
  if (action === 'config') {
    const [verb, key, rawValue, ...extra] = values;
    if (extra.length || rest.some((arg) => arg.startsWith('--') && arg !== '--global' && !arg.startsWith('--project='))) usage();
    const global = rest.includes('--global');
    if (global && projectFlag !== undefined) throw new Error('--global and --project cannot be combined');
    const projectId = global ? undefined : registry.resolve({ explicitProjectId: projectFlag ?? null, env, cwd }).id;
    if (verb === 'list' && key === undefined) return global ? registry.settings() : registry.effectiveSettings(projectId!, {}, env);
    if (verb === 'get' && key && rawValue === undefined) {
      const settings = global ? registry.settings() : registry.effectiveSettings(projectId!, {}, env);
      if (!(key in settings)) throw new Error(`Setting is not configured: ${key}`);
      return { key, value: settings[key] };
    }
    if (verb === 'set' && key && rawValue !== undefined) {
      const value = /^-?\d+$/.test(rawValue) ? Number(rawValue) : rawValue === 'null' ? null : rawValue;
      registry.setSetting(key, value, projectId);
      return { key, value: registry.settings(projectId)[key], scope: projectId ?? 'global' };
    }
    if (verb === 'unset' && key && rawValue === undefined) {
      registry.unsetSetting(key, projectId);
      return { key, scope: projectId ?? 'global', unset: true };
    }
  }
  usage();
}

if (isMainModule(process.argv[1], import.meta.url)) {
  let registry: ProjectRegistry | undefined;
  try {
    registry = new ProjectRegistry();
    console.log(JSON.stringify(runProjectCommand(process.argv.slice(2), registry), null, 2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    registry?.close();
  }
}
