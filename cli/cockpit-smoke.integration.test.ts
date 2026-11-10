/**
 * End-to-end smoke test of the cockpit's attention flow, through the real
 * pieces a user drives: the cockpit (`ensureCockpitWindow`) with the real
 * `orc watch` dashboard beside a fake-provider master, a worker that raises
 * `orc run-input-request`, Enter on the dashboard opening that worker's
 * `orc terminal --write` tab, and `orc run-input-respond` answering it.
 *
 * The coordinator is stood in for by an in-process control server (with the
 * real tmux terminal broker), a process named coordinator.js holding the pid
 * lock, so every orc command finds a live coordinator, and a fast stand-in for
 * the coordinator tick that applies its lifecycle reducer to `input_requested`
 * (it marks the run `awaiting_input`). Skipped without tmux 3.2+.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COCKPIT_SOCKET, COCKPIT_SESSION, DEFAULT_COCKPIT_KEYS, ensureCockpitWindow } from '../adapters/tmuxCockpit.ts';
import { checkTmux, shellQuote, tmuxSessionName, tmuxSocketName } from '../adapters/tmux.ts';
import { startControlServer, type ControlServer } from '../lib/controlServer.ts';
import { setRunInputState } from '../lib/claimManager.ts';
import { closeAllDatabases, initEventsDb, queryEvents, withEventDbTransaction } from '../lib/eventLog.ts';
import { commitClaims } from '../lib/runStore.ts';
import { credentialHash } from '../lib/sessionCredentials.ts';
import { TerminalBroker } from '../lib/terminalBroker.ts';
import { reduceLifecycleEvent } from '../lib/workerLifecycleReducer.ts';
import type { Claim } from '../types/claims.ts';
import { startFakeCoordinator, type FakeCoordinator } from '../test-fixtures/fakeCoordinator.ts';
import { cleanupTempStateDir, createTempStateDir, readClaims, seedState, TEST_PROJECT_ID } from '../test-fixtures/stateHelpers.ts';

const tmuxOk = checkTmux().ok;
const repoRoot = join(import.meta.dirname, '..');
const orc = [process.execPath, join(repoRoot, 'cli', 'orc.ts')];
const QUESTION = 'Which table holds the sessions?';
const ANSWER = 'the sessions table';

let dir: string;
let tmuxTmpdir: string;
let dataHome: string;
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
/** The pane in the slot, and the agent its tab shows (empty for the master). */
const slot = () => {
  const pane = framePanes().find(([role]) => role !== 'sidebar' && role !== 'tabbar') ?? [];
  return { agent: pane.length === 3 ? pane[1] : '', id: pane.at(-1) ?? '' };
};

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
    const child = spawn(orc[0], [...orc.slice(1), ...args], { cwd: repoRoot, env: { ...process.env, ORC_STATE_DIR: dir, ORC_PROJECT_ID: TEST_PROJECT_ID, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(!tmuxOk)('cockpit smoke: question → indicator → agent tab → answer → cleared', () => {
  beforeAll(async () => {
    // The cockpit's socket name is fixed: a private tmux directory keeps it apart from other suites' cockpits.
    tmuxTmpdir = mkdtempSync(join(tmpdir(), 'orc-smoke-tmux-'));
    dataHome = mkdtempSync(join(tmpdir(), 'orc-smoke-data-'));
    process.env.TMUX_TMPDIR = tmuxTmpdir;
    process.env.ORC_DATA_HOME = dataHome;

    dir = createTempStateDir('orc-cockpit-smoke-');
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
      `export ORC_STATE_DIR=${shellQuote(dir)} ORC_PROJECT_ID=${TEST_PROJECT_ID} ORC_SESSION_SECRET=session-a`,
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
    cleanupTempStateDir(dir);
    rmSync(tmuxTmpdir, { recursive: true, force: true });
    rmSync(dataHome, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('shows the question on the dashboard, opens the worker tab on Enter, and clears once answered', async () => {
    expect(ensureCockpitWindow({
      project: { id: 'smoke', name: 'smoke', root: repoRoot, env: { ORC_STATE_DIR: dir } },
      master: { agentId: 'master', socket: tmuxSocketName(dir), session: tmuxSessionName('master') },
      watchCommand: [...orc, 'watch', '--interval-ms=500'],
      orc,
      options: { tmux: 'tmux', trueColor: false },
      keys: DEFAULT_COCKPIT_KEYS,
      size: { columns: 200, rows: 50 },
    })).toBe('created-session');
    // One window: the dashboard in the sidebar, the master in the slot.
    const dashboardPane = frameRole('sidebar');
    const masterPane = slot().id;
    expect(frameRole('tabbar')).not.toBe('');

    // The master pane shows the fake provider; the dashboard lists the worker, with no badge yet.
    await waitFor('the master in its pane', () => capture(masterPane).includes('FIXTURE_READY provider=claude'));
    await waitFor('the worker on the dashboard', () => capture(dashboardPane).includes('worker-a') && capture(dashboardPane).includes('running'));
    expect(capture(dashboardPane)).not.toContain('QUESTION');

    // The worker asks: the dashboard shows the QUESTION badge, the question and the count.
    const workerTarget = `=${tmuxSessionName('worker-a')}:`;
    await waitFor('the worker to start', () => tmux(tmuxSocketName(dir), ['capture-pane', '-p', '-t', workerTarget]).stdout.includes('WORKER-READY'));
    tmux(tmuxSocketName(dir), ['send-keys', '-t', workerTarget, 'Enter']);
    await waitFor('the QUESTION badge', () => {
      const screen = capture(dashboardPane);
      return screen.includes('QUESTION') && screen.includes(QUESTION.slice(0, 20)) && screen.includes('NEEDS YOU');
    });

    // Enter on the dashboard (the worker needing attention is listed first, so selected) opens its tab:
    // `orc terminal worker-a --write`, streaming the worker's screen.
    tmux(COCKPIT_SOCKET, ['send-keys', '-t', dashboardPane, 'Enter']);
    // The tab is shown in the slot, in place of the master; the dashboard stays.
    await waitFor('the worker tab', () => slot().agent === 'worker-a');
    expect(frameRole('sidebar')).toBe(dashboardPane);
    await waitFor('the dashboard to report it', () => capture(dashboardPane).includes('opened worker-a in a new tab'));
    const tabPane = slot().id;
    await waitFor('the worker screen in its tab', () => capture(tabPane).includes('WORKER-READY') && capture(tabPane).includes('writer lease acquired'));

    // Answered: the worker gets the answer (seen through its tab), and the dashboard clears the badge.
    const responded = await runOrc(['run-input-respond', '--run-id=run-a', '--agent-id=worker-a', `--response=${ANSWER}`]);
    expect(responded.code, responded.stderr).toBe(0);
    await waitFor('the answer in the worker tab', () => capture(tabPane).includes(`WORKER-GOT: ${ANSWER}`));
    await waitFor('the badge to clear', () => {
      const screen = capture(dashboardPane);
      return !screen.includes('QUESTION') && !screen.includes('NEEDS YOU') && screen.includes('worker-a');
    });
  }, 90_000);
});
