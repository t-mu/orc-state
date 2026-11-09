#!/usr/bin/env node
/**
 * cli/watch.ts
 * Usage:
 *   node cli/watch.ts [--interval-ms=5000] [--once]
 *
 * Every view is built from orc-state/client: a ProjectWatcher over every
 * registered project, never the state files. The project this command runs
 * for is shown in full; without a running coordinator it is shown as stopped.
 */
import { basename } from 'node:path';
import { render } from 'ink';
import { createElement } from 'react';
import { ProjectWatcher, type ProjectListEntry, type ProjectWatchState, type ProjectWatchUpdate } from '../client.ts';
import { boolFlag, intFlag } from '../lib/args.ts';
import { renderBanner } from '../lib/banner.ts';
import { colorFormatStatus } from '../lib/colorStatus.ts';
import { STATE_DIR, TARGET_REPO_ROOT } from '../lib/paths.ts';
import { describeProjects, listProjects } from '../lib/projectList.ts';
import { cliError, formatErrorMessage } from './shared.ts';

/** What `orc watch` reads: the client's `ProjectWatcher` (tests inject a fake). */
export interface WatchSource {
  start(): void;
  stop(): Promise<void>;
  projects(): ProjectWatchState[];
  onUpdate(listener: (update: ProjectWatchUpdate) => void): () => void;
}

export interface WatchOptions {
  intervalMs: number;
  once: boolean;
  /** State directory of the project shown in full. */
  stateDir: string;
  /** The watcher; a `ProjectWatcher` over the registry (plus `stateDir` when unregistered) by default. */
  source?: WatchSource;
  /** How long `--once` waits for the project's first connection to settle (default 5000 ms). */
  settleTimeoutMs?: number;
}

const once = boolFlag('once');
const intervalMs = intFlag('interval-ms', 5000);

/**
 * The registered projects, plus `stateDir` itself when no registered project
 * owns it (an `ORC_STATE_DIR` without a registry), so it is still watched.
 */
export function watchedProjectList(stateDir: string, list: () => ProjectListEntry[] = () => listProjects()): () => ProjectListEntry[] {
  return () => {
    const listed = list();
    if (listed.some(entry => entry.state_dir === stateDir)) return listed;
    const [own] = describeProjects({
      list: () => [{ id: `unregistered:${stateDir}`, name: basename(stateDir), canonicalGitRoot: TARGET_REPO_ROOT, stateDir, createdAt: '' }],
    });
    return [...listed, own];
  };
}

export function createWatchSource(stateDir: string): WatchSource {
  return new ProjectWatcher({ listProjects: watchedProjectList(stateDir) });
}

function currentProject(source: WatchSource, stateDir: string): ProjectWatchState | null {
  return source.projects().find(state => state.project.state_dir === stateDir) ?? null;
}

/** The first connect has settled: the project is not `connecting`, and a `running` project has its status. */
function settled(state: ProjectWatchState | null): boolean {
  if (!state) return true;
  if (state.connection === 'connecting') return false;
  return state.connection !== 'running' || state.status !== null;
}

/** Resolve once the project's first connection has settled, or after `timeoutMs`. */
export function waitForSettled(source: WatchSource, stateDir: string, timeoutMs: number): Promise<void> {
  if (settled(currentProject(source, stateDir))) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const unsubscribe = source.onUpdate(() => {
      if (settled(currentProject(source, stateDir))) done();
    });
  });
}

function connectionLine(state: ProjectWatchState): string {
  const label = state.connection === 'stopped' ? 'stopped (coordinator not running)' : state.connection;
  return `coordinator: ${state.error ? `${label}: ${state.error}` : label}`;
}

/** The plain snapshot of `stateDir`'s project; false when it cannot be shown (not watched, unreachable, incompatible). */
export function renderPlainSnapshot(source: WatchSource, { intervalMs, stateDir }: Pick<WatchOptions, 'intervalMs' | 'stateDir'>): boolean {
  const state = currentProject(source, stateDir);
  process.stdout.write('\x1b[2J\x1b[H');
  if (process.stdout.isTTY) console.log(renderBanner());

  let ok: boolean;
  if (!state) {
    console.log(`project: not watched (${stateDir})`);
    ok = false;
  } else {
    ok = state.connection === 'running' || state.connection === 'stopped';
    if (state.status && state.connection === 'running') {
      // The status names the project itself (`Orchestrator Status`, then the project line).
      console.log(colorFormatStatus(state.status));
      console.log('');
      console.log(connectionLine(state));
    } else {
      const { project } = state;
      console.log(`project: ${project.name} (${project.id}) → ${project.target_repo_root}`);
      console.log(connectionLine(state));
    }
  }

  const others = source.projects().filter(other => other.project.state_dir !== stateDir);
  if (others.length > 0) {
    console.log('');
    console.log(`Other projects (${others.length}):`);
    for (const other of others) console.log(`  ${other.project.name.padEnd(24)} ${other.connection}`);
  }

  console.log('');
  console.log(`watch interval: ${intervalMs}ms`);
  console.log(`updated at: ${new Date().toISOString()}`);
  return ok;
}

export async function runFallbackWatch(options: WatchOptions): Promise<number | null> {
  const source = options.source ?? createWatchSource(options.stateDir);
  source.start();
  await waitForSettled(source, options.stateDir, options.settleTimeoutMs ?? 5000);

  if (options.once) {
    const ok = renderPlainSnapshot(source, options);
    await source.stop();
    return ok ? 0 : 1;
  }

  renderPlainSnapshot(source, options);
  const timer = setInterval(() => {
    renderPlainSnapshot(source, options);
  }, options.intervalMs);

  const shutdown = () => {
    clearInterval(timer);
    void source.stop().finally(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return null;
}

function runtimeImportPath(relativeTsPath: string, relativeJsPath: string): string {
  return import.meta.url.endsWith('.ts') ? relativeTsPath : relativeJsPath;
}

export async function runTtyWatch(options: WatchOptions): Promise<number> {
  const [appModule, spriteModule] = await Promise.all([
    import(runtimeImportPath('../lib/tui/App.tsx', '../lib/tui/App.js')) as Promise<typeof import('../lib/tui/App.tsx')>,
    import(runtimeImportPath('../lib/tui/sprites.ts', '../lib/tui/sprites.js')) as Promise<typeof import('../lib/tui/sprites.ts')>,
  ]);
  const { App } = appModule;
  const { preloadSprites } = spriteModule;

  let sprites;
  try {
    sprites = await preloadSprites();
  } catch (error) {
    console.error(`Failed to preload watch sprites: ${formatErrorMessage(error)}`);
    return 1;
  }

  const source = options.source ?? createWatchSource(options.stateDir);
  source.start();
  if (options.once) await waitForSettled(source, options.stateDir, options.settleTimeoutMs ?? 5000);

  const instance = render(createElement(App, {
    source,
    stateDir: options.stateDir,
    sprites,
    intervalMs: options.intervalMs,
  }));

  if (options.once) {
    await waitForFirstFrame();
    instance.unmount();
  }

  await instance.waitUntilExit();
  await source.stop();
  return 0;
}

function waitForFirstFrame(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

export async function main(): Promise<number | null> {
  const options: WatchOptions = {
    once,
    intervalMs,
    stateDir: STATE_DIR,
  };

  if (!process.stdout.isTTY) {
    return runFallbackWatch(options);
  }

  return runTtyWatch(options);
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  void main()
    .then(code => {
      if (code !== null) {
        process.exit(code);
      }
    })
    .catch(error => {
      cliError(error);
    });
}
