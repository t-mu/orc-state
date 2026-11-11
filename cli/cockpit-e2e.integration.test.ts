/**
 * End-to-end test of the cockpit as a user runs it: `orc cockpit` in a pane
 * of a host tmux server (the user's terminal), driven by keys, a paste and
 * mouse reports sent to that pane, and read back from the pane's screen.
 *
 * Two registered projects: alpha, running, with a master and a worker; beta,
 * stopped. Their agents are fake programs in alpha's private tmux server that
 * enable bracketed paste, put the terminal in raw mode and append every byte
 * they read to a log file, so the test sees exactly what reached each agent.
 * The coordinator is stood in for by an in-process control server, a process
 * named coordinator.js holding the pid lock, and a fast stand-in for the
 * coordinator tick that marks a run `awaiting_input` on `input_requested`.
 *
 * Every tmux server runs under a private `TMUX_TMPDIR`. Skipped without tmux 3.2+.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTmux, shellQuote, tmuxSessionName, tmuxSocketName } from '../adapters/tmux.ts';
import { startControlServer, type ControlServer } from '../lib/controlServer.ts';
import { setRunInputState } from '../lib/claimManager.ts';
import { closeAllDatabases, initEventsDb, queryEvents, withEventDbTransaction } from '../lib/eventLog.ts';
import { parseViewState } from '../lib/cockpit2/viewState.ts';
import { commitClaims } from '../lib/runStore.ts';
import { ProjectRegistry, writeProjectDescriptor, type ProjectRecord } from '../lib/projectRegistry.ts';
import { credentialHash } from '../lib/sessionCredentials.ts';
import { reduceLifecycleEvent } from '../lib/workerLifecycleReducer.ts';
import type { Claim } from '../types/claims.ts';
import { startFakeCoordinator, type FakeCoordinator } from '../test-fixtures/fakeCoordinator.ts';
import { readClaims, seedState } from '../test-fixtures/stateHelpers.ts';

const tmuxOk = checkTmux().ok;
const repoRoot = join(import.meta.dirname, '..');
const orc = [process.execPath, join(repoRoot, 'cli', 'orc.ts')];
/** The host server: the user's terminal. Its name is none of orc's, so the cockpit runs in it rather than adding itself to a cockpit. */
const HOST = 'orc-e2e-host';
const HOST_COLS = 140;
const HOST_ROWS = 40;
const ESC = '\x1b';
const F12 = `${ESC}[24~`;
const QUESTION = 'Which table holds the sessions?';

/**
 * A fake agent: raw mode, bracketed paste on, every byte read appended to its
 * log and echoed as JSON so its screen shows what it got.
 */
const AGENT_SCRIPT = `
import { appendFileSync } from 'node:fs';
const [name, log] = process.argv.slice(2);
appendFileSync(log, '');
process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?2004h');
process.stdout.write('AGENT ' + name + ' READY\\r\\n');
process.stdin.on('data', (data) => {
  appendFileSync(log, data);
  process.stdout.write('GOT ' + JSON.stringify(data.toString('latin1')) + '\\r\\n');
});
`;

let temp: string;
let dir: string;
let dataHome: string;
let alpha: ProjectRecord;
let beta: ProjectRecord;
let server: ControlServer | null = null;
let coordinator: FakeCoordinator | null = null;
let tickTimer: NodeJS.Timeout | null = null;
let asking: ChildProcess | null = null;
const logs = { master: '', worker: '' };
const saved = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, ORC_DATA_HOME: process.env.ORC_DATA_HOME };

function tmux(socket: string, args: string[]) {
  return spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8', timeout: 10_000 });
}

/** The cockpit's screen as the host terminal shows it. */
const screen = () => tmux(HOST, ['capture-pane', '-p', '-t', `=${HOST}:`]).stdout;
const lines = () => screen().split('\n');
/** What an agent has read so far, byte for byte. */
const received = (agent: keyof typeof logs) => (existsSync(logs[agent]) ? readFileSync(logs[agent], 'latin1') : '');

async function waitFor(what: string, check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}\n--- cockpit\n${screen()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends `bytes` to the cockpit as the terminal would, unchanged. */
function send(bytes: string): void {
  const hex = [...Buffer.from(bytes, 'latin1')].map((byte) => byte.toString(16).padStart(2, '0'));
  const sent = tmux(HOST, ['send-keys', '-t', `=${HOST}:`, '-H', ...hex]);
  expect(sent.status, sent.stderr).toBe(0);
}

/** A left click on the first cell of `text` in the sidebar (SGR mouse, 1-based). */
function clickSidebar(text: string): void {
  const rows = lines();
  const y = rows.findIndex((row) => row.slice(0, 34).includes(text));
  expect(y, `${text} in the sidebar\n${rows.join('\n')}`).toBeGreaterThanOrEqual(0);
  const x = rows[y].indexOf(text);
  send(`${ESC}[<0;${x + 1};${y + 1}M${ESC}[<0;${x + 1};${y + 1}m`);
}

/** The tabs the cockpit saved to its view-state file. */
const savedTabs = () => parseViewState(readFileSync(join(dataHome, 'cockpit', 'view-state.json'), 'utf8')).tabs;

/** Marks a run `awaiting_input` on each new `input_requested`, as the coordinator tick does. */
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

describe.skipIf(!tmuxOk)('orc cockpit end to end, in a host tmux pane', () => {
  beforeAll(async () => {
    temp = mkdtempSync(join(tmpdir(), 'orc-cockpit-e2e-'));
    const tmuxTmpdir = join(temp, 'tmux');
    mkdirSync(tmuxTmpdir);
    dataHome = join(temp, 'data');
    process.env.TMUX_TMPDIR = tmuxTmpdir;
    process.env.ORC_DATA_HOME = dataHome;

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

    // A run that just started: no attention until its worker asks.
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
    writeProjectDescriptor({ id: alpha.id, name: alpha.name, stateDir: dir, targetRepoRoot: alpha.canonicalGitRoot });
    withEventDbTransaction(dir, (db) => db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, transport, started_at, updated_at, credential_hash)
      VALUES ('session-a', 'run-a', 'worker-a', 'claude', 'running', 'tmux', '2026-01-01', '2026-01-01', ?)`).run(credentialHash('session-a')));

    // The agents, in alpha's private tmux server where the cockpit computes their targets.
    const script = join(temp, 'agent.mjs');
    writeFileSync(script, AGENT_SCRIPT);
    logs.master = join(temp, 'master.log');
    logs.worker = join(temp, 'worker.log');
    for (const [agent, log, size] of [['master', logs.master, ['120', '40']], ['worker-a', logs.worker, ['80', '20']]] as const) {
      const created = tmux(tmuxSocketName(dir), ['new-session', '-d', '-s', tmuxSessionName(agent), '-x', size[0], '-y', size[1],
        `${shellQuote(process.execPath)} ${shellQuote(script)} ${agent} ${shellQuote(log)}`]);
      expect(created.status, created.stderr).toBe(0);
    }

    server = await startControlServer(dir, { pollMs: 20 });
    coordinator = await startFakeCoordinator();
    writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: coordinator.pid }));
    tickTimer = startCoordinatorTick();

    // The user's terminal, with the cockpit started in alpha; its exit status stays on the screen.
    const env = { ORC_DATA_HOME: dataHome, TMUX_TMPDIR: tmuxTmpdir, ORC_PROJECT_ID: alpha.id, ORC_STATE_DIR: dir };
    const cockpit = ['env', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), ...orc, 'cockpit'].map(shellQuote).join(' ');
    const command = `${cockpit}; echo COCKPIT-EXIT $?; sleep 600`;
    const host = tmux(HOST, ['new-session', '-d', '-s', HOST, '-x', String(HOST_COLS), '-y', String(HOST_ROWS), '-c', repoRoot, command]);
    expect(host.status, host.stderr).toBe(0);
  }, 30_000);

  afterAll(async () => {
    if (tickTimer) clearInterval(tickTimer);
    asking?.kill('SIGKILL');
    for (const socket of [HOST, tmuxSocketName(dir), 'orc-explorer']) tmux(socket, ['kill-server']);
    await server?.close();
    await coordinator?.stop();
    closeAllDatabases();
    rmSync(temp, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('lists agents, badges a question, shows a worker view-only, types, pastes, ignores mouse motion and restores tabs across a project switch', async () => {
    // The master in the slot, both projects and the worker in the sidebar.
    await waitFor('the master in the slot', () => screen().includes('AGENT master READY'));
    await waitFor('the sidebar to list the worker and both projects', () => {
      const text = screen();
      return text.includes('worker-a') && text.includes(alpha.name) && text.includes(beta.name);
    });
    expect(screen()).not.toContain('QUESTION');

    // The worker asks: its row gets the question badge.
    const ask = [...orc.slice(1), 'run-input-request', '--run-id=run-a', '--agent-id=worker-a', `--question=${QUESTION}`, '--poll-ms=100'];
    asking = spawn(orc[0], ask, { cwd: repoRoot, stdio: 'ignore', env: { ...process.env, ORC_STATE_DIR: dir, ORC_PROJECT_ID: alpha.id, ORC_SESSION_SECRET: 'session-a' } });
    await waitFor('the QUESTION badge', () => screen().includes('QUESTION'));

    // A click on the worker's row shows its screen in a view-only tab: nothing typed reaches it, q closes it.
    clickSidebar('worker-a');
    await waitFor('the worker\'s screen', () => screen().includes('AGENT worker-a READY'));
    await waitFor('the view-only notice', () => screen().includes('[view] i: type'));
    send('x');
    send('q');
    await waitFor('the master back in the slot', () => screen().includes('AGENT master READY') && !screen().includes('AGENT worker-a READY'));
    // Ctrl-D closes it too.
    clickSidebar('worker-a');
    await waitFor('the worker\'s screen again', () => screen().includes('AGENT worker-a READY'));
    send('\x04');
    await waitFor('the master back again', () => !screen().includes('AGENT worker-a READY'));
    await settle();
    expect(received('worker')).toBe('');
    expect(received('master')).toBe('');

    // i starts typing: the keys reach the worker.
    clickSidebar('worker-a');
    await waitFor('the worker\'s screen once more', () => screen().includes('AGENT worker-a READY'));
    send('i');
    await waitFor('the typing notice', () => screen().includes('[typing]'));
    send('hello');
    await waitFor('the keys to reach the worker', () => received('worker') === 'hello');

    // A multi-line paste reaches the bracketed-paste app as one paste (newlines as CR, as a terminal sends them).
    send(`${ESC}[200~line one\nline two\nline three${ESC}[201~`);
    const paste = `${ESC}[200~line one\rline two\rline three${ESC}[201~`;
    await waitFor('the paste to reach the worker', () => received('worker') === `hello${paste}`);

    // Mouse motion over the worker, which asked for no mouse, types nothing: the next key follows the paste directly.
    for (const [x, y] of [[60, 10], [61, 10], [62, 11], [70, 15]]) send(`${ESC}[<35;${x};${y}M`);
    send('z');
    await waitFor('the key after the motion', () => received('worker').endsWith('z'));
    expect(received('worker')).toBe(`hello${paste}z`);
    expect(received('master')).toBe('');

    // Beta from the sidebar and back with the prefix: beta is stopped, alpha comes back with the worker's tab active.
    clickSidebar(beta.name);
    await waitFor('beta in the slot', () => !screen().includes('AGENT worker-a READY') && screen().includes('orc start-session'));
    await waitFor('beta saved as active', () => savedTabs().activeProject === beta.id);
    send(`${F12}P`);
    await waitFor('the worker\'s tab back in the slot', () => screen().includes('AGENT worker-a READY'));
    expect(savedTabs().projects.find((project) => project.projectId === alpha.id)).toMatchObject({ tabs: ['worker-a'], active: 'worker-a' });
    // The tab left returned to view mode: keys do not reach the worker.
    await waitFor('the view-only notice after the switch', () => screen().includes('[view] i: type'));
    send('y');
    await settle();
    expect(received('worker')).toBe(`hello${paste}z`);

    // Quitting ends the cockpit only: both agents keep running.
    send('\x11');
    await waitFor('the cockpit to exit', () => screen().includes('COCKPIT-EXIT 0'));
    for (const agent of ['master', 'worker-a']) expect(tmux(tmuxSocketName(dir), ['has-session', '-t', `=${tmuxSessionName(agent)}`]).status).toBe(0);
  }, 90_000);
});
