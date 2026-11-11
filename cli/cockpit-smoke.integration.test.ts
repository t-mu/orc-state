/**
 * End-to-end smoke test of the cockpit, through the real pieces a user drives:
 * the one-window cockpit (`ensureCockpitWindow`) with the real `orc watch`
 * sidebar, the tab bar and a fake-provider master in the slot; a worker that
 * raises `orc run-input-request` (its badge in the sidebar's Agents and
 * Projects boxes); Enter on the worker making its `orc terminal --view-first` tab
 * the active one in the slot; switching to a second, stopped project and back
 * from the sidebar, which restores the worker's tab; and `orc run-input-respond`
 * answering it, which clears the badge. Both projects are registered.
 *
 * The coordinator is stood in for by an in-process control server (with the
 * real tmux terminal broker), a process named coordinator.js holding the pid
 * lock, so every orc command finds a live coordinator, and a fast stand-in for
 * the coordinator tick that applies its lifecycle reducer to `input_requested`
 * (it marks the run `awaiting_input`). Skipped without tmux 3.2+.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COCKPIT_SOCKET, COCKPIT_SESSION, DEFAULT_COCKPIT_KEYS, ensureCockpitWindow } from '../adapters/tmuxCockpit.ts';
import { checkTmux, shellQuote, tmuxSessionName, tmuxSocketName } from '../adapters/tmux.ts';
import { startControlServer, type ControlServer } from '../lib/controlServer.ts';
import { setRunInputState } from '../lib/claimManager.ts';
import { closeAllDatabases, initEventsDb, queryEvents, withEventDbTransaction } from '../lib/eventLog.ts';
import { commitClaims } from '../lib/runStore.ts';
import { ProjectRegistry, writeProjectDescriptor, type ProjectRecord } from '../lib/projectRegistry.ts';
import { credentialHash } from '../lib/sessionCredentials.ts';
import { TerminalBroker } from '../lib/terminalBroker.ts';
import { reduceLifecycleEvent } from '../lib/workerLifecycleReducer.ts';
import type { Claim } from '../types/claims.ts';
import { startFakeCoordinator, type FakeCoordinator } from '../test-fixtures/fakeCoordinator.ts';
import { readClaims, seedState } from '../test-fixtures/stateHelpers.ts';

const tmuxOk = checkTmux().ok;
const repoRoot = join(import.meta.dirname, '..');
const orc = [process.execPath, join(repoRoot, 'cli', 'orc.ts')];
const QUESTION = 'Which table holds the sessions?';
const ANSWER = 'the sessions table';

let dir: string;
let temp: string;
let tmuxTmpdir: string;
let dataHome: string;
/** The project the cockpit opens in, running (its worker asks the question), and a second one that is stopped. */
let alpha: ProjectRecord;
let beta: ProjectRecord;
let server: ControlServer | null = null;
let coordinator: FakeCoordinator | null = null;
let tickTimer: NodeJS.Timeout | null = null;
const saved = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, ORC_DATA_HOME: process.env.ORC_DATA_HOME };

function tmux(socket: string, args: string[]) {
  return spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8', timeout: 10_000 });
}

async function waitFor(what: string, check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}\n${screens()}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const cockpit = (args: string[]) => tmux(COCKPIT_SOCKET, args).stdout.trim();
const capture = (pane: string) => tmux(COCKPIT_SOCKET, ['capture-pane', '-p', '-J', '-t', pane]).stdout;
/** The frame's panes as `role agent id` (the slot's pane is a tab: `master` or `agent`). */
const framePanes = () => cockpit(['list-panes', '-s', '-t', `=${COCKPIT_SESSION}`, '-F', '#{?#{@orc_frame},#{@orc_role} #{@orc_tab_agent} #{pane_id},}'])
  .split('\n').filter(Boolean).map((line) => line.split(' '));
const frameRole = (role: string) => framePanes().find(([entry]) => entry === role)?.at(-1) ?? '';
/** The pane in the slot: its role (`master`, `message`, `agent`), the agent its tab shows (empty for a project's own tab) and its id. */
const slot = () => {
  const pane = framePanes().find(([role]) => role !== 'sidebar' && role !== 'tabbar') ?? [];
  return { role: pane[0] ?? '', agent: pane.length === 3 ? pane[1] : '', id: pane.at(-1) ?? '' };
};
/** Presses `keys` in the sidebar, one at a time, as a user would. */
async function press(sidebar: string, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    tmux(COCKPIT_SOCKET, ['send-keys', '-t', sidebar, key]);
    await new Promise((r) => setTimeout(r, 150));
  }
}
/** The sidebar's row for a project, e.g. `▸ alpha   running !1`. */
const projectRow = (screen: string, name: string) => screen.split('\n')
  .find((line) => new RegExp(`[▸ ] ${name} .*\\b(running|stopped|stale|incompatible|connecting)\\b`).test(line)) ?? '';

/**
 * The coordinator tick's part in the flow: each new `input_requested` goes
 * through its lifecycle reducer, and `set_input_state` marks the run
 * `awaiting_input` (as coordinator.ts does). Answering clears it through the
 * control API's respond-input, as in production.
 */
function startCoordinatorTick(): NodeJS.Timeout {
  let lastSeq = 0;
  return setInterval(() => {
    for (const event of queryEvents(dir, { event_type: 'input_requested', after_seq: lastSeq })) {
      const row = event as unknown as { seq: number; run_id: string; agent_id: string } & Parameters<typeof reduceLifecycleEvent>[0];
      lastSeq = Math.max(lastSeq, row.seq);
      const claim = (readClaims(dir) as unknown as Claim[]).find((candidate) => candidate.run_id === row.run_id) ?? null;
      const action = reduceLifecycleEvent(row, claim, new Date().toISOString(), { default_ms: 60_000, finalize_ms: 60_000 });
      if (action.type === 'set_input_state') setRunInputState(dir, row.run_id, row.agent_id, { inputState: 'awaiting_input', requestedAt: action.requestedAt });
    }
  }, 20);
}

/** Every cockpit pane and the worker's screen, for a failure message. */
function screens(): string {
  const panes = tmux(COCKPIT_SOCKET, ['list-panes', '-a', '-F', '#{window_name} #{pane_id}']).stdout.trim().split('\n').filter(Boolean);
  const worker = tmux(tmuxSocketName(dir), ['capture-pane', '-p', '-t', `=${tmuxSessionName('worker-a')}:`]).stdout;
  return [...panes.map((line) => `--- ${line}\n${capture(line.split(' ')[1])}`), `--- worker\n${worker}`].join('\n');
}

/** Runs `orc <args>` for the project, as the operator, and resolves with its exit and output. */
function runOrc(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(orc[0], [...orc.slice(1), ...args], { cwd: repoRoot, env: { ...process.env, ORC_STATE_DIR: dir, ORC_PROJECT_ID: alpha.id, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(!tmuxOk)('cockpit smoke: question → badges → agent tab → other project and back → answer → cleared', () => {
  beforeAll(async () => {
    // The cockpit's socket name is fixed: a private tmux directory keeps it apart from other suites' cockpits.
    tmuxTmpdir = mkdtempSync(join(tmpdir(), 'orc-smoke-tmux-'));
    temp = mkdtempSync(join(tmpdir(), 'orc-cockpit-smoke-'));
    dataHome = join(temp, 'data');
    process.env.TMUX_TMPDIR = tmuxTmpdir;
    process.env.ORC_DATA_HOME = dataHome;

    // Two registered projects, listed alpha then beta: the sidebar lists both, and the cockpit can switch between them.
    const gitRepo = (name: string) => {
      const root = join(temp, name);
      mkdirSync(root);
      execFileSync('git', ['init', '-q', root]);
      return realpathSync(root);
    };
    const registry = new ProjectRegistry(dataHome);
    alpha = registry.add(gitRepo('alpha'));
    beta = registry.add(gitRepo('beta'));
    registry.close();
    dir = alpha.stateDir;
    const worktree = join(dir, 'worktree');
    mkdirSync(worktree);
    writeFileSync(join(worktree, '.git'), 'gitdir: dummy');
    // A run that just started and heartbeats: not stalled, so the question is its only attention.
    const now = new Date().toISOString();
    const claim = {
      run_id: 'run-a', task_ref: 'orch/task-a', agent_id: 'worker-a', state: 'in_progress' as const,
      claimed_at: now, started_at: now, last_heartbeat_at: now, lease_expires_at: '2099-01-01T00:00:00.000Z',
    };
    seedState(dir, {
      tasks: [{ ref: 'orch/task-a', title: 'Task A', status: 'in_progress' }],
      claims: [claim],
      agents: [
        { agent_id: 'master', provider: 'claude', role: 'master', capabilities: [], status: 'running', session_handle: 'tmux:master', registered_at: '2026-01-01T00:00:00.000Z' },
        { agent_id: 'worker-a', provider: 'claude', role: 'worker', capabilities: [], status: 'running', session_handle: 'tmux:worker-a', registered_at: '2026-01-01T00:00:00.000Z' },
      ],
    });
    initEventsDb(dir);
    commitClaims(dir, { version: '1', claims: [claim] });
    // seedState marks the directory as the test project's; it is alpha's.
    writeProjectDescriptor({ id: alpha.id, name: alpha.name, stateDir: dir, targetRepoRoot: alpha.canonicalGitRoot });
    withEventDbTransaction(dir, (db) => db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, transport, started_at, updated_at, credential_hash)
      VALUES ('session-a', 'run-a', 'worker-a', 'claude', 'running', 'tmux', '2026-01-01', '2026-01-01', ?)`).run(credentialHash('session-a')));

    // The sessions, in the project's private tmux server: the master runs the fake provider CLI; the worker
    // waits for Enter, then asks its question with run-input-request, as a worker's Bash tool would.
    const orcServer = tmuxSocketName(dir);
    const master = tmux(orcServer, ['new-session', '-d', '-s', tmuxSessionName('master'), '-x', '120', '-y', '40',
      process.execPath, join(repoRoot, 'test-fixtures', 'fake-provider-cli.ts'), 'claude']);
    expect(master.status, master.stderr).toBe(0);
    const ask = [...orc, 'run-input-request', '--run-id=run-a', '--agent-id=worker-a', `--question=${QUESTION}`, '--poll-ms=100'].map(shellQuote).join(' ');
    const workerScript = [
      `export ORC_STATE_DIR=${shellQuote(dir)} ORC_PROJECT_ID=${alpha.id} ORC_SESSION_SECRET=session-a`,
      'echo WORKER-READY',
      'read _',
      `answer=$(${ask})`,
      'echo "WORKER-GOT: $answer"',
      'exec cat',
    ].join('\n');
    const worker = tmux(orcServer, ['new-session', '-d', '-s', tmuxSessionName('worker-a'), '-x', '120', '-y', '40', '-c', repoRoot, '/bin/sh', '-c', workerScript]);
    expect(worker.status, worker.stderr).toBe(0);

    server = await startControlServer(dir, { pollMs: 20, terminals: new TerminalBroker(dir, { worktreeForRun: () => worktree }) });
    coordinator = await startFakeCoordinator();
    writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: coordinator.pid }));
    tickTimer = startCoordinatorTick();
  }, 30_000);

  afterAll(async () => {
    if (tickTimer) clearInterval(tickTimer);
    tmux(COCKPIT_SOCKET, ['kill-server']);
    tmux(tmuxSocketName(dir), ['kill-server']);
    await server?.close();
    await coordinator?.stop();
    closeAllDatabases();
    rmSync(tmuxTmpdir, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('badges the question, shows the worker tab in the slot, keeps it across a project switch, and clears once answered', async () => {
    expect(ensureCockpitWindow({
      // The panes start in this checkout: run from source, the sidebar's and the tab bar's TSX compiles with its tsconfig.
      project: { id: alpha.id, name: alpha.name, root: repoRoot, env: { ORC_PROJECT_ID: alpha.id, ORC_STATE_DIR: dir } },
      master: { agentId: 'master', socket: tmuxSocketName(dir), session: tmuxSessionName('master') },
      watchCommand: [...orc, 'watch', '--interval-ms=500'],
      orc,
      options: { tmux: 'tmux', trueColor: false },
      keys: DEFAULT_COCKPIT_KEYS,
      size: { columns: 200, rows: 50 },
    })).toBe('created-session');
    // One window: the sidebar, the tab bar, and the master in the slot.
    const sidebar = frameRole('sidebar');
    const tabbar = frameRole('tabbar');
    expect(tabbar).not.toBe('');
    const masterPane = slot().id;
    expect(slot().role).toBe('master');
    expect(cockpit(['list-windows', '-t', `=${COCKPIT_SESSION}`, '-F', '#{?#{@orc_frame},frame,#{@orc_holding}}']).split('\n').filter(Boolean).sort())
      .toEqual([alpha.id, 'frame']);

    // The master shows the fake provider; the sidebar lists both projects and the worker, with no badge yet.
    await waitFor('the master in its pane', () => capture(masterPane).includes('FIXTURE_READY provider=claude'));
    await waitFor('the worker in the sidebar', () => {
      const screen = capture(sidebar);
      return screen.includes('worker-a') && projectRow(screen, 'alpha').includes('running') && projectRow(screen, 'beta') !== '';
    });
    expect(capture(sidebar)).not.toContain('QUESTION');
    expect(projectRow(capture(sidebar), 'alpha')).not.toContain('!1');

    // The worker asks: the Agents box shows the QUESTION badge and the question, the Projects box `!1` on alpha.
    const workerTarget = `=${tmuxSessionName('worker-a')}:`;
    await waitFor('the worker to start', () => tmux(tmuxSocketName(dir), ['capture-pane', '-p', '-t', workerTarget]).stdout.includes('WORKER-READY'));
    tmux(tmuxSocketName(dir), ['send-keys', '-t', workerTarget, 'Enter']);
    await waitFor('the QUESTION badge', () => {
      const screen = capture(sidebar);
      return screen.includes('QUESTION') && screen.includes(QUESTION.slice(0, 20)) && screen.includes('1 needs you') && projectRow(screen, 'alpha').includes('!1');
    });
    expect(projectRow(capture(sidebar), 'beta')).not.toContain('!');

    // Enter on the worker (it needs attention, so it is listed first and selected) makes its tab the active one:
    // `orc terminal worker-a --view-first` in the slot, in the master's place; the tab bar lists it.
    await press(sidebar, 'Enter');
    await waitFor('the worker tab in the slot', () => slot().agent === 'worker-a');
    expect(frameRole('sidebar')).toBe(sidebar);
    await waitFor('the sidebar to report it', () => capture(sidebar).includes('Opened worker-a in a new tab.'));
    await waitFor('the tab bar to list it', () => capture(tabbar).includes('worker-a'));
    const tabPane = slot().id;
    await waitFor('the worker screen in its tab', () => capture(tabPane).includes('WORKER-READY') && capture(tabPane).includes('[view] i: type'));

    // Beta, from the Projects box: it is not running, so the slot says how to start it.
    await press(sidebar, 'Tab', 'Down', 'Enter');
    await waitFor('beta in the slot', () => slot().role === 'message' && capture(slot().id).includes(`${beta.name} is not running in the cockpit`));
    await waitFor('beta active in the sidebar', () => projectRow(capture(sidebar), 'beta').includes('▸'));
    await waitFor('the tab bar to drop the worker tab', () => !capture(tabbar).includes('worker-a'));

    // Back to alpha: its tabs as left, the worker tab active, the same pane (its stream never restarted).
    await press(sidebar, 'Up', 'Enter');
    await waitFor('the worker tab back in the slot', () => slot().agent === 'worker-a');
    expect(slot().id).toBe(tabPane);
    await waitFor('the tab bar to list it again', () => capture(tabbar).includes('worker-a'));
    expect(JSON.parse(cockpit(['show-options', '-gqv', '@orc_cockpit_tabs'])).projects.find((project: { projectId: string }) => project.projectId === alpha.id))
      .toMatchObject({ tabs: ['worker-a'], active: 'worker-a' });

    // Answered: the worker gets the answer (seen through its tab), and the sidebar clears both badges.
    const responded = await runOrc(['run-input-respond', '--run-id=run-a', '--agent-id=worker-a', `--response=${ANSWER}`]);
    expect(responded.code, responded.stderr).toBe(0);
    await waitFor('the answer in the worker tab', () => capture(tabPane).includes(`WORKER-GOT: ${ANSWER}`));
    await waitFor('the badges to clear', () => {
      const screen = capture(sidebar);
      return !screen.includes('QUESTION') && !screen.includes('1 needs you') && screen.includes('worker-a') && !projectRow(screen, 'alpha').includes('!1');
    });
  }, 90_000);
});
