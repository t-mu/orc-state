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
import { stringWidth } from '../lib/cellWidth.ts';
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
/** Ctrl-Space, the cockpit's leader: a NUL byte. */
const LEADER = '\x00';
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
let tmuxTmpdir: string;
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
/** The sidebar's rows (the left 34 columns). */
const sidebar = () => lines().map((row) => row.slice(0, 34));
/** The sidebar row that names `text`, or ''. */
const sidebarRow = (text: string) => sidebar().find((row) => row.includes(text)) ?? '';
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

/**
 * Opens an agent's tab from the sidebar as a user does: a click on its row
 * expands it (unless it already is), a click on its `[ INSPECT ]` opens it.
 */
async function openFromSidebar(agent: string): Promise<void> {
  if (sidebarRow(`[-] ${agent}`) === '') clickSidebar(agent);
  await waitFor(`${agent}'s [ INSPECT ]`, () => sidebarRow(`[-] ${agent}`) !== '' && sidebarRow('[ INSPECT ]') !== '');
  clickSidebar('[ INSPECT ]');
}

/**
 * The user's terminal, with the cockpit started in alpha under `extraEnv`
 * (replacing a terminal left by an earlier test); its exit status stays on the screen.
 */
function launchCockpit(extraEnv: Record<string, string>): void {
  tmux(HOST, ['kill-session', '-t', `=${HOST}`]);
  const env = { NO_COLOR: '', ...extraEnv, ORC_DATA_HOME: dataHome, TMUX_TMPDIR: tmuxTmpdir, ORC_PROJECT_ID: alpha.id, ORC_STATE_DIR: dir };
  const cockpit = ['env', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), ...orc, 'cockpit'].map(shellQuote).join(' ');
  const command = `${cockpit}; echo COCKPIT-EXIT $?; sleep 600`;
  const host = tmux(HOST, ['new-session', '-d', '-s', HOST, '-x', String(HOST_COLS), '-y', String(HOST_ROWS), '-c', repoRoot, command]);
  expect(host.status, host.stderr).toBe(0);
}

/** A cell of a `capture-pane -e` capture: its text and the SGR colour it is drawn in (null for the terminal's default). */
interface StyledCell { text: string; fg: string | null; bg: string | null }

/**
 * The cockpit's screen with each cell's colour, from `capture-pane -e`: the
 * SGR sequences are replayed (`0` resets; `30`-`37`, `90`-`97`, `38;5;n`,
 * `38;2;r;g;b` set the foreground, `39` resets it; the same for the
 * background), attributes are ignored.
 */
function styledScreen(): StyledCell[][] {
  const captured = tmux(HOST, ['capture-pane', '-p', '-e', '-t', `=${HOST}:`]).stdout;
  return captured.split('\n').map((line) => {
    const cells: StyledCell[] = [];
    let fg: string | null = null;
    let bg: string | null = null;
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const part of line.split(/(\x1b\[[0-9;:]*m)/)) {
      const sgr = /^\x1b\[([0-9;:]*)m$/.exec(part);
      if (!sgr) {
        for (const { segment } of segmenter.segment(part)) {
          const cell = { text: segment, fg, bg };
          cells.push(cell);
          for (let extra = 1; extra < stringWidth(segment); extra++) cells.push({ ...cell, text: '' });
        }
        continue;
      }
      const params = sgr[1] === '' ? [0] : sgr[1].split(/[;:]/).map(Number);
      for (let i = 0; i < params.length; i++) {
        const p = params[i];
        if (p === 0) { fg = null; bg = null; }
        else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) fg = String(p);
        else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) bg = String(p);
        else if (p === 39) fg = null;
        else if (p === 49) bg = null;
        else if (p === 38 || p === 48) {
          const count = params[i + 1] === 2 ? 5 : 3;
          const color = params.slice(i, i + count).join(';');
          if (p === 38) fg = color;
          else bg = color;
          i += count - 1;
        }
      }
    }
    return cells;
  });
}

/** The cells the cockpit draws itself, by where: the header row, the footer row, the sidebar columns between them. */
function chromeCells(cells: StyledCell[][]): { where: string; cell: StyledCell }[] {
  const rows = cells.slice(0, HOST_ROWS);
  const at = (where: string, row: StyledCell[]) => row.map((cell, x) => ({ where: `${where} col ${x}`, cell }));
  return [
    ...at('header', rows[0]),
    ...at('footer', rows[HOST_ROWS - 1]),
    ...rows.slice(1, HOST_ROWS - 1).flatMap((row, y) => at(`sidebar row ${y + 1}`, row.slice(0, 34))),
  ];
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
    tmuxTmpdir = join(temp, 'tmux');
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

    launchCockpit({ ORC_COCKPIT_THEME: '' });
  }, 30_000);

  afterAll(async () => {
    try {
      if (tickTimer) clearInterval(tickTimer);
      asking?.kill('SIGKILL');
      // Only once TMUX_TMPDIR is private: before that these names would reach the user's servers.
      if (process.env.TMUX_TMPDIR?.startsWith(temp ?? '\0')) {
        for (const socket of [HOST, ...(dir ? [tmuxSocketName(dir)] : []), 'orc-explorer']) tmux(socket, ['kill-server']);
      }
      await server?.close();
      await coordinator?.stop();
      closeAllDatabases();
      if (temp) rmSync(temp, { recursive: true, force: true });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('lists agents, badges a question, shows a worker view-only, types, pastes, ignores mouse motion and restores tabs across a project switch', async () => {
    // The master in the slot; the sidebar lists both projects and the worker (its agents are workers and scouts, never the master).
    await waitFor('the master in the slot', () => screen().includes('AGENT master READY'));
    await waitFor('the master\'s header on the pane box', () => screen().includes('[ MASTER ]') && screen().includes('[COORDINATOR '));
    // Its box leaves `[+] worker… 0m [IN_PROGRESS]` room for the name's start only.
    await waitFor('the sidebar to list the worker and both projects', () =>
      sidebarRow('[+] worker') !== '' && sidebarRow(alpha.name) !== '' && sidebarRow(beta.name) !== '');
    expect(sidebar().join('\n')).not.toContain('QUESTION');

    // The worker asks: its row gets the question badge.
    const ask = [...orc.slice(1), 'run-input-request', '--run-id=run-a', '--agent-id=worker-a', `--question=${QUESTION}`, '--poll-ms=100'];
    asking = spawn(orc[0], ask, { cwd: repoRoot, stdio: 'ignore', env: { ...process.env, ORC_STATE_DIR: dir, ORC_PROJECT_ID: alpha.id, ORC_SESSION_SECRET: 'session-a' } });
    await waitFor('the QUESTION badge on the worker\'s row', () => sidebarRow('worker-a').includes('QUESTION'));

    // A click on the worker's row expands it, one on its [ INSPECT ] shows its screen in a view-only tab: nothing typed reaches it, q closes it.
    await openFromSidebar('worker-a');
    await waitFor('the worker\'s screen', () => screen().includes('AGENT worker-a READY'));
    await waitFor('the worker\'s header on the pane box', () => screen().includes('[ WORKER-A ]') && screen().includes('[QUESTION]'));
    await waitFor('the view-only notice', () => screen().includes('[view] i: type'));
    send('x');
    send('q');
    await waitFor('the master back in the slot', () => screen().includes('AGENT master READY') && !screen().includes('AGENT worker-a READY'));
    // Ctrl-D closes it too.
    await openFromSidebar('worker-a');
    await waitFor('the worker\'s screen again', () => screen().includes('AGENT worker-a READY'));
    send('\x04');
    await waitFor('the master back again', () => !screen().includes('AGENT worker-a READY'));
    await settle();
    expect(received('worker')).toBe('');
    expect(received('master')).toBe('');

    // i starts typing: the keys reach the worker.
    await openFromSidebar('worker-a');
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

    // Beta from the sidebar and back with the leader (previous project): beta is stopped, alpha comes back with the worker's tab active.
    clickSidebar(beta.name);
    await waitFor('beta in the slot', () => !screen().includes('AGENT worker-a READY') && screen().includes('orc start-session'));
    await waitFor('beta saved as active', () => savedTabs().activeProject === beta.id);
    send(`${LEADER}N`);
    await waitFor('the worker\'s tab back in the slot', () => screen().includes('AGENT worker-a READY'));
    expect(savedTabs().projects.find((project) => project.projectId === alpha.id)).toMatchObject({ tabs: ['worker-a'], active: 'worker-a' });
    // The tab left returned to view mode: keys do not reach the worker.
    await waitFor('the view-only notice after the switch', () => screen().includes('[view] i: type'));
    send('y');
    await settle();
    expect(received('worker')).toBe(`hello${paste}z`);

    // Quitting ends the cockpit only: both agents keep running.
    send(`${LEADER}q`);
    await waitFor('the cockpit to exit', () => screen().includes('COCKPIT-EXIT 0'));
    for (const agent of ['master', 'worker-a']) expect(tmux(tmuxSocketName(dir), ['has-session', '-t', `=${tmuxSessionName(agent)}`]).status).toBe(0);
  }, 90_000);

  it('draws the header, footer and sidebar cards without a colour in mono, and expands an agent with Space', async () => {
    launchCockpit({ ORC_COCKPIT_THEME: 'mono' });
    await waitFor('the header', () => lines()[0].startsWith('ORC') && lines()[0].includes(alpha.name));
    await waitFor('the footer', () => lines()[HOST_ROWS - 1].includes('quit'));
    await waitFor('the card titles', () => {
      const shown = sidebar().join('\n');
      return shown.includes(`[ ${alpha.name.toUpperCase()} ]`) && shown.includes('[ CAMPAIGNS ]') && shown.includes('[ GRUNTS ]');
    });
    await waitFor('the worker in the Agents card', () => sidebarRow('[+] worker') !== '');

    // F10 gives the sidebar the keys (the Agents card, its first agent); Space expands the worker into its block.
    send(`${ESC}[21~`);
    await waitFor('the sidebar\'s keys in the footer', () => lines()[HOST_ROWS - 1].includes('Enter: open/expand'));
    send(' ');
    await waitFor('the expanded agent block', () => sidebarRow('[-] worker') !== '' && sidebarRow('orch/task-a') !== '' && sidebarRow('[ INSPECT ] [ KILL ]') !== '');

    const coloured = chromeCells(styledScreen()).filter(({ cell }) => cell.fg !== null || cell.bg !== null);
    expect(coloured.map(({ where, cell }) => `${where} ${JSON.stringify(cell)}`), screen()).toEqual([]);

    send(`${LEADER}q`);
    await waitFor('the cockpit to exit', () => screen().includes('COCKPIT-EXIT 0'));
  }, 60_000);

  it('draws a theme file\'s role colour as true colour', async () => {
    const themeFile = join(temp, 'theme.json');
    writeFileSync(themeFile, JSON.stringify({ base: 'mono', roles: { 'chrome.border': { fg: '#12ab34' } } }));
    launchCockpit({ ORC_COCKPIT_THEME: themeFile, COLORTERM: 'truecolor' });
    await waitFor('the card titles', () => sidebarRow('[ GRUNTS ]') !== '');
    await settle();

    const borders = chromeCells(styledScreen()).filter(({ cell }) => cell.fg === '38;2;18;171;52');
    expect(borders.length, screen()).toBeGreaterThan(0);
    expect(borders.every(({ cell }) => /[─│┌┐└┘├┤ ]/.test(cell.text)), JSON.stringify(borders.filter(({ cell }) => !/[─│┌┐└┘├┤ ]/.test(cell.text)))).toBe(true);

    send(`${LEADER}q`);
    await waitFor('the cockpit to exit', () => screen().includes('COCKPIT-EXIT 0'));
  }, 60_000);

  it('opens a shell tab on the + tab, types into it, and closes it when the shell exits', async () => {
    launchCockpit({ ORC_COCKPIT_THEME: '', SHELL: '/bin/sh' });
    // The + tab on the tabs' label row, right of the sidebar.
    let plus = -1;
    let row = -1;
    await waitFor('the + tab', () => {
      // The tabs' label row (the master's tab on it); the + is its last tab.
      row = lines().findIndex((line, y) => y < 6 && line.slice(34).includes('master'));
      plus = row < 0 ? -1 : lines()[row].lastIndexOf('+');
      return plus > 34 && lines()[row].slice(plus + 1).trim() === '';
    });
    send(`${ESC}[<0;${plus + 1};${row + 1}M${ESC}[<0;${plus + 1};${row + 1}m`);
    await waitFor('the shell tab', () => screen().includes('[ SHELL 1 ]'));
    send('echo hi\r');
    await waitFor('the shell\'s output', () => lines().some((line) => /│hi\s*│/.test(line)));
    send('exit\r');
    await waitFor('the shell tab gone', () => !screen().includes('shell 1') && !screen().includes('[ SHELL 1 ]'));
    expect(received('master')).toBe('');
    expect(received('worker')).not.toContain('echo hi');

    send(`${LEADER}q`);
    await waitFor('the cockpit to exit', () => screen().includes('COCKPIT-EXIT 0'));
  }, 60_000);
});
