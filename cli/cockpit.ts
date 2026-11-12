#!/usr/bin/env node
/**
 * cli/cockpit.ts
 * Usage: orc cockpit
 *        orc cockpit explorer --project=<id>
 *
 * The cockpit: one program draws the whole terminal and shows
 * the active tab (a project's master or an agent) in its slot
 * (lib/cockpit2/app.ts), starting in the current project. This layer resolves
 * everything lib/cockpit2 must not read itself: the tmux binary, the view-state
 * file and the cockpit lock under orc's data home, the cockpit keys and the
 * current project, the terminal's colour depth and the theme, and it runs the project watcher. Quitting (Ctrl-q, or the
 * prefix then d) never stops a master, a worker or a coordinator.
 *
 * `launchCockpit` is the cockpit as `orc cockpit` and `orc start-session` run
 * it: one per user (lib/cockpit2/instance.ts). It takes over
 * a running cockpit, which exits, and a stale lock silently. Launched from
 * inside one of orc's tmux servers (the master's shell, which the cockpit
 * shows), it would nest a cockpit in the cockpit: it adds the project to the
 * view state instead and wakes the running cockpit (SIGUSR2), which shows it.
 * A launch first retires what an older orc left: its cockpit's lock (an old
 * cockpit still running is taken over) and its tmux servers, which only host
 * views.
 *
 * `explorer` runs the read-only task explorer (lib/tui/ExplorerView.ts) for
 * the selected project until Esc or q: what the cockpit's explorer tab runs,
 * in a session on its private tmux server (lib/cockpit2/explorer.ts).
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote, tmuxBinary, tmuxSocketPath } from '../adapters/tmux.ts';
import { ProjectWatcher } from '../client.ts';
import { keyLabel, resolveCockpitKeys, type CockpitKeys } from '../lib/cockpitKeys.ts';
import { projectDataHome } from '../lib/dataHome.ts';
import { ACTIVE_PROJECT } from '../lib/paths.ts';
import { ProjectRegistry } from '../lib/projectRegistry.ts';
import type { SettingsHost } from '../lib/cockpit2/settingsDialog.ts';
import { isSameProcess, readProcessStart } from '../lib/processIdentity.ts';
import { quitHint, runApp, type AppExit } from '../lib/cockpit2/app.ts';
import { colorDepthFromEnv } from '../lib/cockpit2/color.ts';
import { tmuxExplorerHost } from '../lib/cockpit2/explorer.ts';
import { DEFAULT_THEME, terminalColorsEnter, terminalColorsLeave, themeFromEnv, type Theme } from '../lib/cockpit2/theme.ts';
import { claimInstance, exitRequested, liveInstance, type InstanceHolder } from '../lib/cockpit2/instance.ts';
import { fdWriter, openTerminal } from '../lib/cockpit2/terminal.ts';
import { addProject, createViewStateStore } from '../lib/cockpit2/viewState.ts';
import { cliError, requireProjectScope } from './shared.ts';

/** Where the cockpit keeps its files under orc's data home: the single-instance lock, the view state and its write lock. */
export function cockpitPaths(dataHome: string): { lockPath: string; viewStatePath: string; viewStateLockPath: string } {
  const dir = join(dataHome, 'cockpit');
  return { lockPath: join(dir, 'cockpit.lock'), viewStatePath: join(dir, 'view-state.json'), viewStateLockPath: join(dir, 'view-state.lock') };
}

/** The instance lock an older orc's cockpit holds (it was named for the cockpit2 preview). */
export function oldCockpitLockPath(dataHome: string): string {
  return join(dataHome, 'cockpit', 'cockpit2.lock');
}

function runtimeImportPath(relativeTsPath: string, relativeJsPath: string): string {
  return import.meta.url.endsWith('.ts') ? relativeTsPath : relativeJsPath;
}

/** The per-project selection a cockpit started inside a project or a worker inherits; the explorer takes its project from `--project` alone. */
const PROJECT_ENV = ['ORC_PROJECT_ID', 'ORC_STATE_DIR', 'ORC_CONTROL_SOCKET', 'ORC_PROJECT_FLAG'];

/** The shell command the explorer tab's session runs: `orc cockpit explorer --project=<id>` with this orc. */
export function explorerCommand(orc: string[], projectId: string): string {
  return `unset ${PROJECT_ENV.join(' ')}; ${[...orc, 'cockpit', 'explorer', `--project=${projectId}`].map(shellQuote).join(' ')}`;
}

/** Runs a command and calls back with its outcome, as `execFile` does (injectable in tests). */
export type RunCommand = (file: string, args: string[], options: { env: NodeJS.ProcessEnv; encoding: 'utf8' },
  callback: (error: Error | null, stdout: string, stderr: string) => void) => unknown;

/** The command line that restarts `projectId`'s coordinator: `orc --project=<id> coordinator restart --json`. */
export function coordinatorRestartCommand(orc: string[], projectId: string): { file: string; args: string[] } {
  return { file: orc[0], args: [...orc.slice(1), `--project=${projectId}`, 'coordinator', 'restart', '--json'] };
}

/** Why a `--json` command failed: its JSON error's message (printed on stdout), else stderr's last line, else the exit error. */
export function commandFailure(error: Error, stdout: string, stderr: string): string {
  try {
    const message = (JSON.parse(stdout) as { error?: { message?: unknown } }).error?.message;
    if (typeof message === 'string' && message) return message;
  } catch { /* not JSON */ }
  return stderr.trim().split('\n').at(-1) || error.message;
}

/**
 * The settings dialog's host: a project's effective settings and project-scope
 * writes through the global registry (as `orc project config list|set
 * --project`), and a coordinator restart as `orc --project=<id> coordinator
 * restart`, run without this process's project environment.
 */
export function registrySettingsHost(orc: string[], registry: ProjectRegistry = new ProjectRegistry(), run: RunCommand = execFile as unknown as RunCommand): SettingsHost {
  return {
    read: (projectId) => registry.effectiveSettings(projectId, {}, process.env),
    write: (projectId, key, value) => registry.setSetting(key, value, projectId),
    restartCoordinator: (projectId) => new Promise((resolve, reject) => {
      const env = { ...process.env };
      for (const key of PROJECT_ENV) delete env[key];
      const { file, args } = coordinatorRestartCommand(orc, projectId);
      run(file, args, { env, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) reject(new Error(commandFailure(error, String(stdout ?? ''), String(stderr ?? ''))));
        else resolve();
      });
    }),
  };
}

/** The command that runs this orc (from source or compiled). */
const thisOrc = (): string[] => [process.execPath, fileURLToPath(new URL(runtimeImportPath('./orc.ts', './orc.js'), import.meta.url))];

/** The tmux servers an older orc's cockpit ran: the tmux-pane cockpit's and the cockpit2 preview's explorer server. Both only host views. */
export const OLD_COCKPIT_SOCKETS = ['orc-cockpit', 'orc-cockpit2'];
/** orc's tmux servers: a project's (lib/tmuxNames.ts `tmuxSocketName`), the explorer's and an older orc's cockpit servers. */
const ORC_SOCKET = /^orc-(?:[0-9a-f]{12}|explorer|cockpit2?)$/;

/**
 * Whether `TMUX` says this process runs in a pane of one of orc's tmux
 * servers: an agent's session (the master's shell, which the cockpit shows) or
 * a cockpit's. A cockpit started there would run inside the cockpit.
 */
export function insideOrcTmux(env: NodeJS.ProcessEnv = process.env, socketDir = dirname(tmuxSocketPath('orc'))): boolean {
  const socket = env.TMUX?.split(',')[0];
  return !!socket && dirname(socket) === socketDir && ORC_SOCKET.test(basename(socket));
}

/** What a launch does: run the cockpit in this terminal (taking over a running one), or add the project to the cockpit and wake it. */
export type CockpitLaunch = 'run' | 'add';

/** From inside orc's tmux servers a cockpit would nest: the project is added instead, whether or not a cockpit runs. */
export function cockpitLaunch(nested: boolean): CockpitLaunch {
  return nested ? 'add' : 'run';
}

/** This process as the instance lock names it. */
function thisProcess(): InstanceHolder {
  return { pid: process.pid, start: readProcessStart(process.pid) ?? `pid:${process.pid}` };
}

/** Wakes a running cockpit: it exits when asked to (an exit request), else reloads its view state. */
const WAKE_SIGNAL = 'SIGUSR2';
const ignoreWake = () => { /* a wake-up for a cockpit that has ended */ };
function wakeCockpit(holder: InstanceHolder): void {
  try { process.kill(holder.pid, WAKE_SIGNAL); } catch { /* exited meanwhile */ }
}

/** The cockpit's files and store under `dataHome`. */
function cockpitFiles(dataHome: string) {
  const paths = cockpitPaths(dataHome);
  return { ...paths, store: createViewStateStore({ path: paths.viewStatePath, lockPath: paths.viewStateLockPath }) };
}

/**
 * Adds `projectId` to the cockpit's view state as its active project and wakes
 * the running cockpit, which then shows it. Resolves with that cockpit, or
 * null when none runs (the next cockpit opens with the project).
 */
export async function addToCockpit(projectId: string, dataHome = projectDataHome()): Promise<InstanceHolder | null> {
  const { lockPath, store } = cockpitFiles(dataHome);
  await addProject(store, projectId);
  const running = liveInstance(lockPath, isSameProcess);
  if (running) wakeCockpit(running);
  return running;
}

/** A file's text, or null when it cannot be read: how `cockpitTheme` reads an `ORC_COCKPIT_THEME` file. */
export function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The theme the cockpit draws in, from `NO_COLOR` and `ORC_COCKPIT_THEME`
 * (theme.ts `themeFromEnv`), and its problems. The entry points resolve it
 * beside the cockpit keys and print each problem as they print the key
 * problems; a problem never stops the cockpit (a theme that cannot be used
 * gives `amber`).
 */
export function cockpitTheme(
  env: Record<string, string | undefined> = process.env,
  readText: (path: string) => string | null = readTextOrNull,
): { theme: Theme; problems: string[] } {
  return themeFromEnv(env, readText);
}

export interface CockpitOptions {
  projectId: string;
  keys: CockpitKeys;
  /** The theme the cockpit draws in (`cockpitTheme`). */
  theme: Theme;
  /** orc's data home (default: `projectDataHome()`). */
  dataHome?: string;
  /** Called once this cockpit holds the instance lock, before it takes the terminal: `replaced` is the running cockpit asked to exit. */
  onClaimed?(replaced: InstanceHolder | null): void;
}

export interface CockpitResult {
  /** `quit`: the user quit; `takeover`: another cockpit asked this one to exit. */
  ended: AppExit;
  /** Why the view state was not saved, already reported; null when it was. */
  saveError: string | null;
}

/**
 * Runs the cockpit in this terminal until it quits or another cockpit takes
 * over, then restores the terminal and releases the instance lock. Throws,
 * with the terminal restored, when the lock cannot be taken (a running cockpit
 * did not exit) or the app fails to start.
 */
export async function runCockpit(options: CockpitOptions): Promise<CockpitResult> {
  const { lockPath, store } = cockpitFiles(options.dataHome ?? projectDataHome());
  const self = thisProcess();
  // Listening before the lock names this process: SIGUSR2's default action ends it, and a
  // wake-up can come before the app runs (it is then handled once the app does).
  let app: ReturnType<typeof runApp> | null = null;
  let wokenEarly = false;
  const wake = () => {
    if (!app) { wokenEarly = true; return; }
    if (exitRequested(lockPath, self, isSameProcess)) app.quit('takeover');
    else app.reloadViewState();
  };
  process.on(WAKE_SIGNAL, wake);
  let claim;
  try {
    claim = await claimInstance({ lockPath, self, isRunning: isSameProcess, wake: wakeCockpit });
  } catch (error) {
    process.off(WAKE_SIGNAL, wake);
    throw error;
  }
  // An exit that skips the cleanup below (a crash) still frees the lock; SIGTERM and SIGHUP do so only once
  // openTerminal installed its handlers, and a kill -9 leaves it stale (the next cockpit takes it over silently).
  const release = claim.release;
  process.on('exit', release);
  const watcher = new ProjectWatcher();
  let terminal: ReturnType<typeof openTerminal> | null = null;
  try {
    options.onClaimed?.(claim.replaced);
    watcher.start();
    const theme = options.theme ?? DEFAULT_THEME;
    terminal = openTerminal({
      input: process.stdin, output: process.stdout, write: fdWriter(process.stdout.fd),
      enter: terminalColorsEnter(theme), leave: terminalColorsLeave(theme),
    });
    app = runApp({
      terminal,
      tmuxBinary: tmuxBinary(),
      store,
      projects: watcher,
      projectId: options.projectId,
      keys: options.keys,
      colorDepth: colorDepthFromEnv(process.env),
      theme: options.theme,
      explorer: tmuxExplorerHost({ tmuxBinary: tmuxBinary(), command: (projectId) => explorerCommand(thisOrc(), projectId) }),
      settings: registrySettingsHost(thisOrc()),
    });
    if (wokenEarly) wake();
    const ended = await app.done;
    const saveError = app.saveError();
    if (saveError) console.error(`Warning: the cockpit's view state was not saved: ${saveError}`);
    return { ended, saveError };
  } catch (error) {
    // Back on the main screen first, or the error is printed on the alternate one and lost.
    terminal?.restore();
    throw error;
  } finally {
    // Released first, and SIGUSR2 stays ignored for the rest of this process (start-session goes on
    // to retire an ended master): a wake-up sent by someone who read the lock just before still lands.
    release();
    if (!process.listeners(WAKE_SIGNAL).includes(ignoreWake)) process.on(WAKE_SIGNAL, ignoreWake);
    process.off(WAKE_SIGNAL, wake);
    process.off('exit', release);
    await watcher.stop();
  }
}

/** The keys the cockpit names when it opens. */
export function cockpitOpeningHint(keys: CockpitKeys): string {
  return [...(keys.direct.dashboard ? [`${keyLabel(keys.direct.dashboard)}: sidebar`] : []), quitHint(keys)].join(' · ');
}

/**
 * Retires what an older orc's cockpit left, once: a running one is taken over
 * through its lock (`cockpit/cockpit2.lock`), which is then removed, and its
 * tmux servers are ended (they only host views, so no master, worker or
 * coordinator stops; with none running, tmux says so and nothing happens).
 * Throws when a running old cockpit does not exit in time.
 */
export async function retireOldCockpit(dataHome = projectDataHome(), tmux = tmuxBinary()): Promise<void> {
  const lockPath = oldCockpitLockPath(dataHome);
  if (existsSync(lockPath)) {
    const claim = await claimInstance({ lockPath, self: thisProcess(), isRunning: isSameProcess, wake: wakeCockpit });
    claim.release();
  }
  for (const socket of OLD_COCKPIT_SOCKETS) {
    spawnSync(tmux, ['-L', socket, '-f', '/dev/null', 'kill-server'], { encoding: 'utf8', timeout: 10_000 });
  }
}

/** How a cockpit launch ended: the cockpit ran here, or the project was added to the cockpit (`running`, null when none runs). */
export type CockpitLaunchResult =
  | ({ kind: 'ran' } & CockpitResult)
  | { kind: 'added'; running: InstanceHolder | null };

/** What `orc cockpit` and `orc start-session` run on a terminal: an older orc's cockpit is retired, then the cockpit runs here or, nested, the project is added to it. */
export async function launchCockpit(options: CockpitOptions & { env?: NodeJS.ProcessEnv }): Promise<CockpitLaunchResult> {
  if (cockpitLaunch(insideOrcTmux(options.env)) === 'add') {
    return { kind: 'added', running: await addToCockpit(options.projectId, options.dataHome) };
  }
  await retireOldCockpit(options.dataHome);
  return { kind: 'ran', ...await runCockpit(options) };
}

async function explorer(): Promise<void> {
  requireProjectScope();
  if (!ACTIVE_PROJECT) cliError('orc cockpit explorer needs a project: --project=<id>');
  // Loaded on demand: the explorer is a TSX view, and the cockpit must not load Ink.
  const { runTaskExplorer } = await (import(runtimeImportPath('../lib/tui/ExplorerView.ts', '../lib/tui/ExplorerView.js')) as Promise<typeof import('../lib/tui/ExplorerView.ts')>);
  process.exit(await runTaskExplorer(ACTIVE_PROJECT.id, new ProjectWatcher()));
}

async function main(): Promise<void> {
  const [action, ...rest] = process.argv.slice(2);
  if (action === 'explorer') {
    if (rest.length > 0) cliError(`orc cockpit explorer takes no arguments besides --project=<id> (got ${rest.join(' ')})`);
    return explorer();
  }
  if (action !== undefined) cliError(`unknown action '${action}' (orc cockpit --help)`);
  requireProjectScope();
  if (!process.stdin.isTTY || !process.stdout.isTTY) cliError('orc cockpit needs a terminal (stdin and stdout must be a TTY)');
  const { keys, problems } = resolveCockpitKeys();
  const { theme, problems: themeProblems } = cockpitTheme();
  for (const problem of [...problems, ...themeProblems]) console.error(`Warning: ${problem}`);
  if (!ACTIVE_PROJECT) cliError('orc cockpit needs a registered project; run it inside one');
  try {
    const launch = await launchCockpit({ projectId: ACTIVE_PROJECT.id, keys, theme });
    if (launch.kind === 'added') {
      console.log(launch.running
        ? `Added ${ACTIVE_PROJECT.name} to the cockpit (pid ${launch.running.pid}); it shows the project now.`
        : `Added ${ACTIVE_PROJECT.name} to the cockpit; it opens there the next time a cockpit runs in a terminal outside orc's tmux sessions.`);
    } else if (launch.ended === 'takeover') {
      console.log('The cockpit moved to another terminal.');
    }
  } catch (error) {
    cliError(error);
  }
  process.exit(0);
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch(cliError);
}
