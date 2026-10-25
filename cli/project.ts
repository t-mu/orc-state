#!/usr/bin/env node
/** Global project registry commands; these do not need an orc repository. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProjectRegistry } from '../lib/projectRegistry.ts';
import { createProjectTask, describeProjectTask, initProjectTaskStore, reviseProjectTask } from '../lib/projectTasks.ts';
import { isMainModule } from './orc.ts';

function option(args: string[], name: string): string | undefined {
  const prefixed = args.find((arg) => arg.startsWith(`--${name}=`));
  return prefixed?.slice(name.length + 3);
}

function positionals(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith('--'));
}

function usage(): never {
  throw new Error('Usage: orc project add <git-path> [--name=N] | list | select <id> | show [--project=id] | config <list|get|set|unset> [key] [value] [--global] [--project=id] | task <list|show|revisions|create|edit> [ref] [--project=id]');
}

const TASK_FIELD_FLAGS: Record<string, string> = {
  title: 'title', feature: 'feature', ref: 'ref', priority: 'priority', description: 'description',
  'task-type': 'task_type', 'required-provider': 'required_provider', model: 'model',
  'review-level': 'review_level', 'merge-strategy': 'merge_strategy', owner: 'owner',
};

/** Task fields from flags; `--body-file` reads Markdown from any path, `--depends-on`/`--ac` are comma or repeat lists. */
function taskInput(args: string[], allowed: readonly string[]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const arg of args.filter((item) => item.startsWith('--'))) {
    const [name] = arg.slice(2).split('=', 1);
    if (!allowed.includes(name)) usage();
  }
  for (const [flagName, field] of Object.entries(TASK_FIELD_FLAGS)) {
    const value = option(args, flagName);
    if (value !== undefined) input[field] = value;
  }
  const bodyFile = option(args, 'body-file');
  if (bodyFile !== undefined) input.body_markdown = readFileSync(resolve(bodyFile), 'utf8');
  const list = (name: string) => args.filter((arg) => arg.startsWith(`--${name}=`)).flatMap((arg) => arg.slice(name.length + 3).split(',')).map((item) => item.trim()).filter(Boolean);
  if (args.some((arg) => arg.startsWith('--depends-on='))) input.depends_on = list('depends-on');
  if (args.some((arg) => arg.startsWith('--ac='))) input.acceptance_criteria = list('ac');
  return input;
}

function runTaskCommand(args: string[], stateDir: string): unknown {
  const [verb, ...rest] = args;
  const values = positionals(rest);
  const store = initProjectTaskStore(stateDir);
  const actor = option(rest, 'actor-id') ?? 'human';
  if (verb === 'list' && values.length === 0) return store.listTasks().map((task) => ({ ref: task.ref, title: task.title, status: task.status, spec_revision: task.revision }));
  if (verb === 'show' && values.length === 1) {
    const revision = option(rest, 'revision');
    if (revision !== undefined) {
      const found = store.getRevision(values[0], Number(revision));
      if (!found) throw new Error(`Revision not found: ${values[0]}@${revision}`);
      return found;
    }
    const task = store.getTask(values[0]);
    if (!task) throw new Error(`Task not found: ${values[0]}`);
    return describeProjectTask(task);
  }
  if (verb === 'revisions' && values.length === 1) {
    if (!store.getTask(values[0])) throw new Error(`Task not found: ${values[0]}`);
    return store.listRevisions(values[0]);
  }
  const fieldFlags = [...Object.keys(TASK_FIELD_FLAGS), 'body-file', 'depends-on', 'ac', 'project', 'actor-id'];
  if (verb === 'create' && values.length === 0) return describeProjectTask(createProjectTask(stateDir, taskInput(rest, fieldFlags), actor));
  if (verb === 'edit' && values.length === 1) {
    const expected = option(rest, 'expected-revision');
    const input = taskInput(rest, [...fieldFlags.filter((flag) => !['feature', 'ref', 'owner'].includes(flag)), 'expected-revision']);
    const { task, changed } = reviseProjectTask(stateDir, values[0], expected === undefined ? undefined : Number(expected), input, actor);
    return { ...describeProjectTask(task), changed };
  }
  usage();
}

export function runProjectCommand(args: string[], registry: ProjectRegistry, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): unknown {
  const [action, ...rest] = args;
  const values = positionals(rest);
  const projectFlag = option(rest, 'project');
  if (action === 'add') {
    if (values.length !== 1 || rest.some((arg) => arg.startsWith('--') && !arg.startsWith('--name='))) usage();
    const project = registry.add(values[0], option(rest, 'name'));
    // A registered project's tasks live in its own SQLite store from the start.
    initProjectTaskStore(project.stateDir);
    return project;
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
  if (action === 'task') {
    return runTaskCommand(rest, registry.resolve({ explicitProjectId: projectFlag ?? null, env, cwd }).stateDir);
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
