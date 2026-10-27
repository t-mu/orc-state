/**
 * Clean-repository project workflow, end to end (plan 3, step 11).
 *
 * A disposable target Git repository with no orc files is registered as a
 * project. Tasks are authored through the CLI (one database-only, one imported
 * from Markdown outside the repository) and exported again. The real
 * coordinator — started and stopped through `main()`/`doShutdown()` — then
 * dispatches both tasks to concurrent workers over the real tmux transport.
 * Mid-run the CLI and TUI inspect and attach, the coordinator restarts and
 * adopts the live sessions, and both runs finish through its merge into the
 * target repository.
 *
 * Only the provider is simulated. Each tmux session runs a stand-in `claude`
 * binary that stays alive and ignores its input; what a real provider would do
 * with its bootstrap and messages is played by the test, and every lifecycle
 * step is a real `orc` CLI subprocess run with the environment the coordinator
 * handed to that session. The product change is a real commit in the
 * assigned worktree.
 *
 * Workers run sandboxed (Task 229): their sandbox settings never grant the
 * project state directory, and each worker `orc` call runs under Node's
 * permission model with write access only to the worktrees and the target's
 * `.git` write subtrees and with native addons disabled, so it cannot open
 * SQLite at all. Every lifecycle step must reach the coordinator through its
 * control socket.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSocketPath } from '../lib/controlProtocol.ts';

const ORC = resolve(import.meta.dirname, '..', 'cli', 'orc.ts');
const ORC_ENV_KEYS = ['ORC_STATE_DIR', 'ORC_HOME', 'ORC_REPO_ROOT', 'ORC_CONFIG_FILE', 'ORC_PROJECT_ID', 'ORC_DATA_HOME',
  'ORC_BACKLOG_DIR', 'ORC_PLANS_DIR', 'ORC_WORKTREES_DIR', 'ORC_MAX_WORKERS', 'ORC_WORKER_PROVIDER', 'ORC_WORKER_MODEL',
  'ORC_SESSION_TOKEN', 'ORC_CONTROL_SOCKET', 'ORC_CONTROL_API', 'ORC_SESSION_TRANSPORT'];
const PROCESS_EVENTS = ['SIGINT', 'SIGTERM', 'exit', 'unhandledRejection', 'uncaughtException'] as const;

let temp: string;
let target: string;
let dataHome: string;
let savedEnv: NodeJS.ProcessEnv;
let tmuxSocket: string | null = null;

/** The ambient environment without any orc selection, plus this test's data home and stand-in provider. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...savedEnv };
  for (const key of ORC_ENV_KEYS) delete env[key];
  return {
    ...env, PATH: `${join(temp, 'bin')}:${savedEnv.PATH ?? ''}`,
    ORC_DATA_HOME: dataHome, ORC_SESSION_TRANSPORT: 'tmux', ...extra,
  };
}

function orc(args: string[], { cwd = target, env = cleanEnv() }: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(process.execPath, [ORC, ...args], { cwd, env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function orcOk(args: string[], options?: Parameters<typeof orc>[1]): string {
  const result = orc(args, options);
  if (result.status !== 0) throw new Error(`orc ${args.join(' ')} failed (${result.status}): ${result.stderr}${result.stdout}`);
  return result.stdout;
}

/**
 * A worker `orc` call. It runs asynchronously because the coordinator — and its
 * control socket — lives in this test process; a synchronous child would block
 * the socket it is waiting on.
 */
function orcAsync(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [ORC, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (status) => {
      if (status === 0) resolvePromise(stdout);
      else reject(new Error(`orc ${args.join(' ')} failed (${status}): ${stderr}${stdout}`));
    });
  });
}

/**
 * Node's permission model as a stand-in sandbox: read anything, write only
 * `writable`. Leaving out --allow-addons also blocks better-sqlite3, whose
 * native writes the fs permissions would not see.
 */
function sandboxNodeOptions(writable: string[]): string {
  return ['--permission', '--allow-fs-read=*', '--allow-child-process', '--allow-worker',
    ...writable.map((path) => `--allow-fs-write=${path}`)].join(' ');
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=Worker', '-c', 'user.email=worker@example.com', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function json<T>(text: string): T {
  return JSON.parse(text) as T;
}

type Adapter = Record<string, unknown> & {
  start: (agentId: string, config: Record<string, unknown>) => Promise<unknown>;
  send: (handle: string, text: string) => Promise<unknown>;
};
interface Pending { agentId: string; kind: 'report' | 'task' | 'rebase' | 'rebased' | 'finish'; runId: string; token?: string; worktree?: string; specPath?: string }

/**
 * What the providers would do with their input. `wrap` decorates each real
 * adapter the coordinator creates: launches and messages go through the real
 * transport unchanged, and the resulting worker actions are queued here and
 * performed between ticks, after the coordinator has written its state.
 */
function makeWorkers(writable: string[]) {
  const envs = new Map<string, NodeJS.ProcessEnv>();
  const settings = new Map<string, { allowWrite: string[]; unixSockets: string[] }>();
  const pending: Pending[] = [];
  const workerOrc = (agentId: string, args: string[], cwd: string) => orcAsync(args, cwd,
    { ...cleanEnv(), ...envs.get(agentId), NODE_OPTIONS: sandboxNodeOptions(writable) });

  function wrap(real: Adapter): Adapter {
    return {
      ...real,
      async start(agentId: string, config: Record<string, unknown>) {
        const result = await real.start(agentId, config);
        envs.set(agentId, config.env as NodeJS.ProcessEnv);
        // The sandbox the provider was launched with (removed again when the session stops).
        const { STATE_DIR } = await import('../lib/paths.ts');
        const launched = json<{ sandbox?: { filesystem: { allowWrite: string[] }; network?: { allowUnixSockets: string[] } } }>(
          readFileSync(join(STATE_DIR, 'pty-settings', `${agentId}.json`), 'utf8'));
        settings.set(agentId, { allowWrite: launched.sandbox?.filesystem.allowWrite ?? [], unixSockets: launched.sandbox?.network?.allowUnixSockets ?? [] });
        // The provider reads its bootstrap once running, after the coordinator has recorded the session.
        pending.push({ agentId, kind: 'report', runId: '', token: /session-token=(\S+)/.exec(String(config.system_prompt))![1] });
        return result;
      },
      async send(handle: string, text: string) {
        const result = await real.send(handle, text);
        const agentId = handle.replace(/^tmux:/, '');
        const runId = /\nrun_id: (\S+)/.exec(`\n${text}`)?.[1] ?? '';
        if (text.startsWith('TASK_START')) {
          pending.push({ agentId, kind: 'task', runId,
            worktree: /assigned_worktree: (\S+)/.exec(text)![1], specPath: /task_spec_path: (\S+)/.exec(text)![1] });
        } else if (/^FINALIZE_REBASE$/m.test(text)) {
          pending.push({ agentId, kind: 'rebase', runId });
        } else if (/^FINALIZE_SUCCESS$/m.test(text)) {
          pending.push({ agentId, kind: 'finish', runId });
        }
        return result;
      },
    };
  }

  function take(kind: Pending['kind']): Pending[] {
    const items = pending.filter((item) => item.kind === kind);
    for (const item of items) pending.splice(pending.indexOf(item), 1);
    return items;
  }

  async function reportForDuty() {
    for (const item of take('report')) {
      await workerOrc(item.agentId, ['report-for-duty', `--agent-id=${item.agentId}`, `--session-token=${item.token}`], tmpdir());
    }
  }

  /** Start every delivered task (both workers are in progress before either completes). */
  async function startTasks(): Promise<Array<Required<Pending>>> {
    await reportForDuty();
    const started = take('task') as Array<Required<Pending>>;
    for (const item of started) {
      await workerOrc(item.agentId, ['run-start', `--run-id=${item.runId}`, `--agent-id=${item.agentId}`], item.worktree);
      await workerOrc(item.agentId, ['progress', '--event=phase_started', '--phase=implement', `--run-id=${item.runId}`, `--agent-id=${item.agentId}`], item.worktree);
    }
    return started;
  }

  /** The product change: a file named after the task, holding its pinned spec's title. */
  async function completeTask(item: Required<Pending>) {
    const title = /^#\s+(.+)$/m.exec(readFileSync(item.specPath, 'utf8'))![1];
    const file = `${title.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}.txt`;
    writeFileSync(join(item.worktree, file), `${title}\n`);
    git(item.worktree, 'add', file);
    git(item.worktree, 'commit', '-qm', `feat: ${title}`);
    await workerOrc(item.agentId, ['review-submit', `--run-id=${item.runId}`, `--agent-id=${item.agentId}`, '--outcome=approved', '--reason=looks right'], item.worktree);
    // Reads work in the sandbox too: the coordinator serves them (task 230).
    const reviews = await workerOrc(item.agentId, ['review-read', `--run-id=${item.runId}`, '--json'], item.worktree);
    expect(json<{ count: number; reviews: Array<{ payload: { findings: string } }> }>(reviews)).toMatchObject({ count: 1, reviews: [{ payload: { findings: 'looks right' } }] });
    await workerOrc(item.agentId, ['memory-record', `--content=${title} lives in its own file`], item.worktree);
    expect(await workerOrc(item.agentId, ['memory-wake-up'], item.worktree)).toContain(`${title} lives in its own file`);
    await workerOrc(item.agentId, ['run-work-complete', `--run-id=${item.runId}`, `--agent-id=${item.agentId}`], item.worktree);
  }

  /** Follow-ups the coordinator asked for: a finalize rebase, or the terminal run-finish. */
  async function handleFollowUps(worktrees: Map<string, string>) {
    await reportForDuty();
    for (const item of take('rebased')) await workerOrc(item.agentId, ['run-work-complete', `--run-id=${item.runId}`, `--agent-id=${item.agentId}`], worktrees.get(item.runId)!);
    for (const item of take('rebase')) {
      const worktree = worktrees.get(item.runId)!;
      await workerOrc(item.agentId, ['progress', '--event=finalize_rebase_started', `--run-id=${item.runId}`, `--agent-id=${item.agentId}`], worktree);
      git(worktree, 'rebase', '-q', 'main');
      // Reported after the coordinator has seen the rebase start (a real rebase spans ticks).
      pending.push({ ...item, kind: 'rebased' });
    }
    // The coordinator removes the worktree once merged; the worker's env still names its project.
    for (const item of take('finish')) await workerOrc(item.agentId, ['run-finish', `--run-id=${item.runId}`, `--agent-id=${item.agentId}`], tmpdir());
  }

  return { wrap, settings, workerOrc, startTasks, completeTask, handleFollowUps };
}

beforeEach(() => {
  savedEnv = { ...process.env };
  temp = realpathSync(mkdtempSync(join(tmpdir(), 'orc-clean-repo-')));
  dataHome = join(temp, 'data');
  // The stand-in provider: alive until stopped, ignoring whatever is typed into it.
  mkdirSync(join(temp, 'bin'));
  writeFileSync(join(temp, 'bin', 'claude'), '#!/bin/sh\nexec sleep 600\n');
  chmodSync(join(temp, 'bin', 'claude'), 0o755);
  target = join(temp, 'product');
  mkdirSync(target);
  git(target, 'init', '-q', '-b', 'main');
  // The coordinator's merge commits need an identity; repository config lives in .git, not the working tree.
  git(target, 'config', 'user.name', 'Coordinator');
  git(target, 'config', 'user.email', 'coordinator@example.com');
  writeFileSync(join(target, 'README.md'), '# Product\n');
  git(target, 'add', 'README.md');
  git(target, 'commit', '-qm', 'initial');
});

afterEach(() => {
  if (tmuxSocket) spawnSync('tmux', ['-L', tmuxSocket, 'kill-server']);
  tmuxSocket = null;
  process.env = savedEnv;
  vi.doUnmock('../adapters/index.ts');
  vi.doUnmock('../lib/sessionSupervisor.ts');
  vi.resetModules();
  rmSync(temp, { recursive: true, force: true });
});

describe('clean-repository project workflow', () => {
  it('registers, authors, dispatches concurrently, survives a restart and merges only product commits', async () => {
    const initial = git(target, 'rev-parse', 'HEAD');

    // ── Register and configure: nothing is written into the target. ──────────
    const project = json<{ id: string; stateDir: string }>(orcOk(['project', 'add', target, '--name=demo'], { cwd: temp }));
    orcOk(['project', 'config', 'set', 'worker_pool.max_workers', '2']);
    orcOk(['project', 'config', 'set', 'worker_pool.provider', 'claude']);
    orcOk(['project', 'config', 'set', 'worker_pool.execution_mode', 'sandbox']);
    // The test drives ticks itself; the coordinator's own timer never fires.
    orcOk(['project', 'config', 'set', 'coordinator.tick_interval_ms', '3600000']);

    // ── Author: one database-only task, one imported from Markdown outside the repo; then export. ──
    mkdirSync(join(temp, 'specs'));
    writeFileSync(join(temp, 'specs', 'alpha-body.md'), '# Alpha\n\nCreate alpha.txt.\n\n## Acceptance criteria\n\n- [ ] alpha.txt exists\n');
    const alpha = json<{ ref: string }>(orcOk(['project', 'task', 'create', '--feature=app', '--ref=alpha', `--body-file=${join(temp, 'specs', 'alpha-body.md')}`]));
    expect(alpha.ref).toBe('app/alpha');
    writeFileSync(join(temp, 'specs', 'beta.md'), '---\nref: app/beta\nfeature: app\npriority: high\n---\n\n# Beta\n\nCreate beta.txt.\n');
    expect(json<{ imported: Array<{ action: string }> }>(orcOk(['project', 'task', 'import', join(temp, 'specs', 'beta.md')])).imported[0].action).toBe('created');
    const exported = json<Array<{ path: string }>>(orcOk(['project', 'task', 'export', join(temp, 'exports')]));
    expect(exported.map((entry) => entry.path).sort()).toEqual([join(temp, 'exports', 'app', 'alpha.md'), join(temp, 'exports', 'app', 'beta.md')]);
    expect(readdirSync(target).sort()).toEqual(['.git', 'README.md']);
    expect(git(target, 'status', '--porcelain')).toBe('');

    // ── Start the real coordinator in project mode. ─────────────────────────
    process.env = cleanEnv({ ORC_PROJECT_ID: project.id });
    const gitWritable = ['objects', 'refs', 'logs', 'worktrees'].map((sub) => join(target, '.git', sub));
    const workers = makeWorkers([join(project.stateDir, 'worktrees'), ...gitWritable]);
    vi.doMock('../adapters/index.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../adapters/index.ts')>();
      return { ...actual, createAdapter: (provider: string) => workers.wrap(actual.createAdapter(provider) as unknown as Adapter) };
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const listeners = Object.fromEntries(PROCESS_EVENTS.map((name) => [name, process.listeners(name)]));
    const { STATE_DIR, ACTIVE_PROJECT } = await import('../lib/paths.ts');
    const tmux = await import('../adapters/tmux.ts');
    tmuxSocket = tmux.tmuxSocketName(STATE_DIR);
    let coordinator = await import('../coordinator.ts');
    try {
      expect(ACTIVE_PROJECT?.id).toBe(project.id);
      expect(STATE_DIR).toBe(project.stateDir);
      await coordinator.main();

      const claims = () => json<{ claims: Array<{ run_id: string; task_ref: string; agent_id: string; state: string }> }>(readFileSync(join(STATE_DIR, 'claims.json'), 'utf8')).claims;
      const events = async () => (await import('../lib/eventLog.ts')).readEvents(join(STATE_DIR, 'events.db')).map((event) => event.event);
      let started = await workers.startTasks();
      for (let i = 0; i < 10 && started.length < 2; i += 1) {
        await coordinator.tick();
        started = [...started, ...await workers.startTasks()];
      }
      expect(started).toHaveLength(2);
      expect(claims().filter((claim) => claim.state === 'in_progress').map((claim) => claim.task_ref).sort()).toEqual(['app/alpha', 'app/beta']);
      const worktrees = new Map(started.map((item) => [item.runId, item.worktree]));
      for (const item of started) {
        // Worktrees belong to the target repository but live in the external state directory.
        expect(item.worktree.startsWith(join(project.stateDir, 'worktrees'))).toBe(true);
        expect(realpathSync(git(item.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'))).toBe(join(target, '.git'));
        // The worker received the pinned revision body, not a repository file.
        expect(item.specPath.startsWith(join(project.stateDir, 'run-specs'))).toBe(true);
        // Sandboxed without the state directory: only the control socket and the target's .git write subtrees.
        const sandbox = workers.settings.get(item.agentId)!;
        expect(sandbox.allowWrite).toEqual(['.', defaultSocketPath(project.stateDir), ...gitWritable]);
        expect(sandbox.unixSockets).toEqual([defaultSocketPath(project.stateDir)]);
      }
      // The credential must own the run: a worker cannot act on its peer's run, even naming the peer's agent.
      const [first, second] = started;
      await expect(workers.workerOrc(first.agentId, ['progress', '--event=phase_started', '--phase=review', `--run-id=${second.runId}`, `--agent-id=${second.agentId}`], first.worktree))
        .rejects.toThrow(/Session belongs to/);
      await expect(workers.workerOrc(first.agentId, ['run-fail', `--run-id=${second.runId}`, `--agent-id=${first.agentId}`], first.worktree))
        .rejects.toThrow(/not scoped to run/);
      // Without a session credential a project lifecycle command is refused outright.
      expect(orc(['run-start', `--run-id=${first.runId}`, `--agent-id=${first.agentId}`]).stderr).toContain('ORC_SESSION_TOKEN is not set');

      // ── Inspect and attach through the CLI and the TUI while both runs are active. ──
      const status = json<{ project: { id: string } }>(orcOk(['status', '--json']));
      expect(status.project.id).toBe(project.id);
      const active = json<{ project: { id: string }; runs: Array<{ run_id: string; task_status: string; spec_revision: number }> }>(orcOk(['runs-active', '--json']));
      expect(active.project.id).toBe(project.id);
      expect(active.runs.map((run) => run.task_status).sort()).toEqual(['in_progress', 'in_progress']);
      expect(active.runs.every((run) => run.spec_revision === 1)).toBe(true);
      const tui = orcOk(['watch', '--once']);
      expect(tui).toContain(`demo (${project.id})`);
      for (const item of started) expect(tui).toContain(item.agentId);
      const attached = orc(['attach', started[0].agentId]);
      expect(attached.status, attached.stderr).toBe(0);
      expect(attached.stderr).toContain(`project: demo (${project.id})`);
      // Attach reads that session's real output: the bootstrap the coordinator typed into it.
      expect(attached.stdout).toContain(`agent_id: ${started[0].agentId}`);
      expect(orcOk(['run-info', started[0].runId])).toContain(started[0].runId);

      // ── Restart the coordinator mid-run: shut down, start again, adopt the live sessions. ──
      await workers.completeTask(started[0]);
      await coordinator.doShutdown();
      expect(await events()).toContain('coordinator_stopped');
      // Reads fall back to the state directory while the coordinator is down. The stand-in sandbox cannot load
      // SQLite at all, so here that fallback fails, and says to retry (a real sandbox opens it read-only).
      await expect(workers.workerOrc(started[1].agentId, ['review-read', `--run-id=${started[1].runId}`], started[1].worktree))
        .rejects.toThrow(/retry once the coordinator is running/);
      for (const item of started) {
        expect(spawnSync('tmux', ['-L', tmuxSocket, 'has-session', '-t', `=${tmux.tmuxSessionName(item.agentId)}`]).status).toBe(0);
      }
      vi.resetModules();
      // A new coordinator process has its own owner identity (here the same test process stands in for it).
      vi.doMock('../lib/sessionSupervisor.ts', async (importOriginal) => ({
        ...await importOriginal<typeof import('../lib/sessionSupervisor.ts')>(), currentSessionOwnerId: () => 'pid:restarted-coordinator',
      }));
      coordinator = await import('../coordinator.ts');
      const log = vi.spyOn(console, 'log');
      await coordinator.main();
      const startupLog = log.mock.calls.map((call) => call.join(' ')).join('\n');
      log.mockRestore();
      expect(startupLog).toContain(`(${started[1].agentId}): running -> running [adopted]`);
      expect((await events()).filter((event) => event === 'coordinator_started')).toHaveLength(2);
      // The still-working session was adopted; the finished one was merged on the first tick and closed.
      const { sessions } = json<{ sessions: Array<{ agent_id: string; state: string; state_reason: string | null; owner_id: string }> }>(orcOk(['sessions', '--all', '--json']));
      const sessionOf = (agentId: string) => sessions.find((session) => session.agent_id === agentId);
      expect(sessionOf(started[1].agentId)).toMatchObject({ state: 'running', state_reason: null, owner_id: 'pid:restarted-coordinator' });
      expect(sessionOf(started[0].agentId)).toMatchObject({ state: 'offline' });
      expect(claims().find((claim) => claim.run_id === started[0].runId)?.state).toBe('done');

      await workers.completeTask(started[1]);
      for (let i = 0; i < 20 && !claims().every((claim) => claim.state === 'done'); i += 1) {
        await coordinator.tick();
        await workers.handleFollowUps(worktrees);
      }
      // No run was redispatched across the restart; both finished through the merge.
      expect(claims().map((claim) => [claim.run_id, claim.state]).sort()).toEqual(started.map((item) => [item.runId, 'done']).sort());
      // Every worker step was applied by the coordinator on their behalf.
      const recorded = await events();
      for (const name of ['reported_for_duty', 'run_started', 'phase_started', 'review_submitted', 'work_complete', 'run_finished']) {
        expect(recorded, name).toContain(name);
      }

      // ── Only the intended product commits reached the target. ────────────────
      expect(git(target, 'status', '--porcelain')).toBe('');
      expect(readdirSync(target).sort()).toEqual(['.git', 'README.md', 'alpha.txt', 'beta.txt']);
      const changed = git(target, 'log', '--name-only', '--format=', `${initial}..main`).split('\n').filter(Boolean);
      expect([...new Set(changed)].sort()).toEqual(['alpha.txt', 'beta.txt']);
      expect(git(target, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toEqual([`worktree ${target}`]);

      // ── Status and config survive into new sessions; doctor passes. ──────────
      const tasks = json<Array<{ ref: string; status: string }>>(orcOk(['project', 'task', 'list']));
      expect(tasks.map((task) => [task.ref, task.status]).sort()).toEqual([['app/alpha', 'done'], ['app/beta', 'done']]);
      expect(json<{ value: number }>(orcOk(['project', 'config', 'get', 'worker_pool.max_workers'])).value).toBe(2);
      // Doctor checks the host's real sandbox prerequisites, which a test container may lack.
      orcOk(['project', 'config', 'set', 'worker_pool.execution_mode', 'full-access']);
      const doctor = orc(['doctor', '--json']);
      expect(doctor.status, doctor.stdout).toBe(0);
      expect(json<{ ok: boolean }>(doctor.stdout).ok).toBe(true);

      // ── A stale Markdown export cannot requeue a completed task. ─────────────
      const stale = join(temp, 'exports', 'app', 'alpha.md');
      writeFileSync(stale, readFileSync(stale, 'utf8').replace('---\n', '---\nstatus: todo\n'));
      const reimport = json<{ imported: Array<{ ref: string; action: string; ignored_fields: string[] }> }>(orcOk(['project', 'task', 'import', join(temp, 'exports')]));
      expect(reimport.imported.find((entry) => entry.ref === 'app/alpha')).toMatchObject({ action: 'unchanged', ignored_fields: ['status'] });
      await coordinator.tick();
      await coordinator.tick();
      expect(claims()).toHaveLength(2);
      expect(json<Array<{ status: string }>>(orcOk(['project', 'task', 'list'])).every((task) => task.status === 'done')).toBe(true);
      expect(readdirSync(target).sort()).toEqual(['.git', 'README.md', 'alpha.txt', 'beta.txt']);
    } finally {
      await coordinator.doShutdown();
      exit.mockRestore();
      for (const name of PROCESS_EVENTS) {
        for (const listener of process.listeners(name)) if (!listeners[name].includes(listener)) process.removeListener(name, listener as () => void);
      }
    }
  }, 180_000);
});
