#!/usr/bin/env node
/** Global project registry commands; these do not need an orc repository. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProjectRegistry } from '../lib/projectRegistry.ts';
import { ensureStateInitialized } from '../lib/stateInit.ts';
import { createProjectTask, describeProjectTask, initProjectTaskStore, reviseProjectTask } from '../lib/projectTasks.ts';
import { migrateLegacyInstallation, migrationCleanupReport } from '../lib/projectMigration.ts';
import { exportPlanMarkdown, exportTaskMarkdown, importPlanMarkdown, importTaskMarkdown, importTaskMarkdownSources, readTaskMarkdownSources } from '../lib/taskMarkdown.ts';
import { isMainModule } from './orc.ts';
import { submitProjectWrite } from '../lib/projectWriteDispatch.ts';

function option(args: string[], name: string): string | undefined {
  const prefixed = args.find((arg) => arg.startsWith(`--${name}=`));
  return prefixed?.slice(name.length + 3);
}

function positionals(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith('--'));
}

function usage(): never {
  throw new Error('Usage: orc project add <git-path> [--name=N] | list | select <id> | show [--project=id] | config <list|get|set|unset> [key] [value] [--global] [--project=id] | task <list|show|revisions|create|edit|import|export> [ref|path] [--project=id] | plan <list|show|import|export> [id|path] [--project=id] | migrate [legacy-path] [--execute [--name=N] | --cleanup-report]');
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
  if (verb === 'import' && values.length === 1 && rest.every((arg) => !arg.startsWith('--') || ['--strict'].includes(arg) || /^--(project|actor-id)=/.test(arg))) {
    return importTaskMarkdown(stateDir, values[0], { strict: rest.includes('--strict'), actorId: actor });
  }
  if (verb === 'export' && values.length === 1 && rest.every((arg) => !arg.startsWith('--') || /^--(project|ref)=/.test(arg))) {
    const refs = rest.filter((arg) => arg.startsWith('--ref=')).flatMap((arg) => arg.slice(6).split(',')).filter(Boolean);
    return exportTaskMarkdown(stateDir, values[0], { refs });
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
    // A registered project's state directory is complete, and its tasks live in its own SQLite store, from the start.
    ensureStateInitialized(project.stateDir);
    initProjectTaskStore(project.stateDir);
    return project;
  }
  if (action === 'migrate') {
    // Dry run by default; the legacy installation is found from the path (default: cwd).
    if (values.length > 1 || rest.some((arg) => arg.startsWith('--') && !['--execute', '--cleanup-report'].includes(arg) && !arg.startsWith('--name='))) usage();
    const source = values[0] ?? cwd;
    if (rest.includes('--cleanup-report')) {
      if (rest.length !== values.length + 1) usage();
      return migrationCleanupReport(source, registry);
    }
    if (option(rest, 'name') !== undefined && !rest.includes('--execute')) usage();
    return migrateLegacyInstallation(source, registry, { execute: rest.includes('--execute'), name: option(rest, 'name') });
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
  if (action === 'plan') {
    const stateDir = registry.resolve({ explicitProjectId: projectFlag ?? null, env, cwd }).stateDir;
    const [verb, target, destination, ...extra] = values;
    if (extra.length || rest.some((arg) => arg.startsWith('--') && !arg.startsWith('--project='))) usage();
    const store = initProjectTaskStore(stateDir);
    if (verb === 'list' && target === undefined) return store.listPlans();
    if (verb === 'show' && target !== undefined && destination === undefined) {
      const plan = store.getPlan(Number(target));
      if (!plan) throw new Error(`Plan not found: ${target}`);
      return plan;
    }
    if (verb === 'import' && target !== undefined && destination === undefined) return importPlanMarkdown(stateDir, target);
    if (verb === 'export' && target !== undefined && destination !== undefined) return { path: exportPlanMarkdown(stateDir, Number(target), destination) };
    usage();
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

/** The CLI's project task writes use the daemon whenever it owns the project. */
export async function runProjectCommandRouted(args: string[], registry: ProjectRegistry, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Promise<unknown> {
  const [action, ...rest] = args;
  if (action !== 'task') return runProjectCommand(args, registry, env, cwd);
  const [verb, ...flags] = rest;
  if (!['create', 'edit', 'import'].includes(verb)) return runProjectCommand(args, registry, env, cwd);
  const stateDir = registry.resolve({ explicitProjectId: option(flags, 'project') ?? null, env, cwd }).stateDir;
  const actorId = option(flags, 'actor-id');
  if (verb === 'create') {
    if (positionals(flags).length !== 0) usage();
    const input = taskInput(flags, [...Object.keys(TASK_FIELD_FLAGS), 'body-file', 'depends-on', 'ac', 'project', 'actor-id']);
    return submitProjectWrite<unknown>(stateDir, 'task create', actorId,
      async (client) => (await client.createTask(input, actorId)).task,
      (actor) => describeProjectTask(createProjectTask(stateDir, input, actor)));
  }
  const values = positionals(flags);
  if (values.length !== 1) usage();
  if (verb === 'import') {
    if (flags.some((arg) => arg.startsWith('--') && arg !== '--strict' && !/^--(project|actor-id)=/.test(arg))) usage();
    const strict = flags.includes('--strict');
    const { sources, skipped } = readTaskMarkdownSources(values[0]);
    return submitProjectWrite<unknown>(stateDir, 'task import', actorId,
      async (client) => ({ ...(await client.importTasks(sources, strict, actorId)), skipped }),
      (actor) => ({ imported: importTaskMarkdownSources(stateDir, sources, { strict, actorId: actor }), skipped }));
  }
  const expected = option(flags, 'expected-revision');
  const input = taskInput(flags, [...Object.keys(TASK_FIELD_FLAGS).filter((flag) => !['feature', 'ref', 'owner'].includes(flag)),
    'body-file', 'depends-on', 'ac', 'project', 'actor-id', 'expected-revision']);
  if (expected === undefined) throw new Error('expected_revision is required for project task edits');
  return submitProjectWrite<unknown>(stateDir, 'task edit', actorId,
    async (client) => { const result = await client.reviseTask(values[0], Number(expected), input, actorId); return { ...result.task, changed: result.changed }; },
    (actor) => { const result = reviseProjectTask(stateDir, values[0], Number(expected), input, actor); return { ...describeProjectTask(result.task), changed: result.changed }; });
}

if (isMainModule(process.argv[1], import.meta.url)) {
  let registry: ProjectRegistry | undefined;
  try {
    registry = new ProjectRegistry();
    const result = await runProjectCommandRouted(process.argv.slice(2), registry);
    console.log(JSON.stringify(result, null, 2));
    // A migration that was refused or failed verification changed nothing it would cut over.
    const status = (result as { status?: unknown } | null)?.status;
    if (status === 'blocked' || status === 'verification_failed') process.exitCode = 1;
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    registry?.close();
  }
}
