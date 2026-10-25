/**
 * Clean-repository project workflow, end to end (plan 3, step 11).
 *
 * A disposable target Git repository with no orc files is registered as a
 * project. Tasks are authored through the CLI (one database-only, one imported
 * from Markdown outside the repository) and exported again. The real
 * coordinator then dispatches both tasks to concurrent workers. Each simulated
 * provider session acts as a worker would: every lifecycle step is a real
 * `orc` CLI subprocess run with the environment the coordinator handed to the
 * session, and the product change is a real commit in the assigned worktree.
 * Mid-run the CLI and TUI inspect and attach, the coordinator restarts, and
 * both runs finish through the coordinator's merge into the target repository.
 *
 * Only the provider session is simulated: a long-lived process stands in for
 * the provider CLI (so liveness probes, attach and pid files are real), and its
 * output log is written where the PTY adapter writes it.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processIdentity } from '../lib/processIdentity.ts';

const ORC = resolve(import.meta.dirname, '..', 'cli', 'orc.ts');
const ORC_ENV_KEYS = ['ORC_STATE_DIR', 'ORC_HOME', 'ORC_REPO_ROOT', 'ORC_CONFIG_FILE', 'ORC_PROJECT_ID', 'ORC_DATA_HOME',
  'ORC_BACKLOG_DIR', 'ORC_PLANS_DIR', 'ORC_WORKTREES_DIR', 'ORC_MAX_WORKERS', 'ORC_WORKER_PROVIDER', 'ORC_WORKER_MODEL',
  'ORC_SESSION_TOKEN', 'ORC_CONTROL_SOCKET', 'ORC_CONTROL_API', 'ORC_SESSION_TRANSPORT'];

let temp: string;
let target: string;
let dataHome: string;
let savedEnv: NodeJS.ProcessEnv;
const providerProcesses: ChildProcess[] = [];

/** The ambient environment without any orc selection, plus this test's data home. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...savedEnv };
  for (const key of ORC_ENV_KEYS) delete env[key];
  return { ...env, ORC_DATA_HOME: dataHome, ORC_CONTROL_API: 'off', ...extra };
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

function git(cwd: string, ...args: string[]): string {
  return execGit(cwd, args).trim();
}

function execGit(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=Worker', '-c', 'user.email=worker@example.com', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

interface Session { agentId: string; env: NodeJS.ProcessEnv; cwd: string; stateDir: string; process: ChildProcess; stopped: boolean }

/**
 * Provider sessions that outlive a coordinator (as tmux sessions do): the same
 * adapter object serves the coordinator before and after its restart. Worker
 * actions are queued by `send` and performed between ticks, like a provider
 * acting on its input after the coordinator has written it.
 */
function makeProviderSessions() {
  const sessions = new Map<string, Session>();
  const pending: Array<{ agentId: string; kind: 'report' | 'task' | 'rebase' | 'rebased' | 'finish'; runId: string; token?: string; worktree?: string; specPath?: string }> = [];
  const log = (session: Session, text: string) => appendFileSync(join(session.stateDir, 'pty-logs', `${session.agentId}.log`), `${text}\n`);
  const workerOrc = (session: Session, args: string[], cwd = session.cwd) => orcOk(args, { cwd, env: { ...cleanEnv(), ...session.env } });
  const agentOf = (handle: string) => handle.replace(/^pty:/, '');

  const adapter = {
    start(agentId: string, config: { env: NodeJS.ProcessEnv; system_prompt: string; working_directory: string }) {
      const stateDir = config.env.ORC_STATE_DIR!;
      const child = spawn('sleep', ['600'], { stdio: 'ignore' });
      providerProcesses.push(child);
      mkdirSync(join(stateDir, 'pty-pids'), { recursive: true });
      mkdirSync(join(stateDir, 'pty-logs'), { recursive: true });
      writeFileSync(join(stateDir, 'pty-pids', `${agentId}.pid`), JSON.stringify(processIdentity(child.pid!)));
      const session: Session = { agentId, env: config.env, cwd: config.working_directory, stateDir, process: child, stopped: false };
      sessions.set(agentId, session);
      log(session, `provider session for ${agentId} in ${session.cwd}`);
      // The provider reads its bootstrap once it is running, after the coordinator has recorded the session.
      pending.push({ agentId, kind: 'report', runId: '', token: /session-token=(\S+)/.exec(config.system_prompt)![1] });
      return Promise.resolve({ session_handle: `pty:${agentId}`, provider_ref: { provider: 'claude' } });
    },
    send(handle: string, text: string) {
      const session = sessions.get(agentOf(handle))!;
      log(session, text);
      const runId = /\nrun_id: (\S+)/.exec(`\n${text}`)?.[1] ?? '';
      if (text.startsWith('TASK_START')) {
        pending.push({ agentId: session.agentId, kind: 'task', runId,
          worktree: /assigned_worktree: (\S+)/.exec(text)![1], specPath: /task_spec_path: (\S+)/.exec(text)![1] });
      } else if (/^FINALIZE_REBASE$/m.test(text)) {
        pending.push({ agentId: session.agentId, kind: 'rebase', runId });
      } else if (/^FINALIZE_SUCCESS$/m.test(text)) {
        pending.push({ agentId: session.agentId, kind: 'finish', runId });
      }
      return Promise.resolve('');
    },
    attach: vi.fn(),
    heartbeatProbe(handle: string) { return Promise.resolve(sessions.get(agentOf(handle))?.stopped === false); },
    stop(handle: string) {
      const session = sessions.get(agentOf(handle));
      if (session && !session.stopped) { session.stopped = true; session.process.kill(); }
      return Promise.resolve();
    },
    getOutputTail(handle: string) {
      const session = sessions.get(agentOf(handle));
      return session ? readFileSync(join(session.stateDir, 'pty-logs', `${session.agentId}.log`), 'utf8') : null;
    },
    ownsSession(handle: string) { return sessions.has(agentOf(handle)); },
  };

  /** Bootstrapped providers report for duty. */
  function reportForDuty() {
    for (const item of pending.filter((entry) => entry.kind === 'report')) {
      pending.splice(pending.indexOf(item), 1);
      const session = sessions.get(item.agentId)!;
      workerOrc(session, ['report-for-duty', `--agent-id=${item.agentId}`, `--session-token=${item.token}`]);
    }
  }

  /** Start every queued task (both workers are in progress before either completes). */
  function startTasks(): Array<{ agentId: string; runId: string; worktree: string; specPath: string }> {
    reportForDuty();
    const started = pending.filter((item) => item.kind === 'task').map((item) => item as Required<typeof item>);
    for (const item of started) {
      pending.splice(pending.indexOf(item), 1);
      const session = sessions.get(item.agentId)!;
      workerOrc(session, ['run-start', `--run-id=${item.runId}`, `--agent-id=${item.agentId}`], item.worktree);
    }
    return started;
  }

  /** The product change: a file named after the task, holding its pinned spec's title. */
  function completeTask(item: { agentId: string; runId: string; worktree: string; specPath: string }) {
    const session = sessions.get(item.agentId)!;
    const title = /^#\s+(.+)$/m.exec(readFileSync(item.specPath, 'utf8'))![1];
    const file = `${title.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}.txt`;
    writeFileSync(join(item.worktree, file), `${title}\n`);
    git(item.worktree, 'add', file);
    git(item.worktree, 'commit', '-qm', `feat: ${title}`);
    workerOrc(session, ['run-work-complete', `--run-id=${item.runId}`, `--agent-id=${item.agentId}`], item.worktree);
  }

  /** Follow-ups the coordinator asked for: a finalize rebase, or the terminal run-finish. */
  function handleFollowUps() {
    reportForDuty();
    for (const item of pending.splice(0, pending.length)) {
      const session = sessions.get(item.agentId)!;
      if (item.kind === 'rebase') {
        workerOrc(session, ['progress', '--event=finalize_rebase_started', `--run-id=${item.runId}`, `--agent-id=${item.agentId}`]);
        git(session.cwd, 'rebase', '-q', 'main');
        // Reported after the coordinator has seen the rebase start (a real rebase spans ticks).
        pending.push({ ...item, kind: 'rebased' });
      } else if (item.kind === 'rebased') {
        workerOrc(session, ['run-work-complete', `--run-id=${item.runId}`, `--agent-id=${item.agentId}`]);
      } else if (item.kind === 'finish') {
        // The coordinator removes the worktree once merged; the worker's env still names its project.
        workerOrc(session, ['run-finish', `--run-id=${item.runId}`, `--agent-id=${item.agentId}`], tmpdir());
      } else {
        pending.push(item);
      }
    }
  }

  return { adapter, sessions, startTasks, completeTask, handleFollowUps };
}

function json<T>(text: string): T {
  return JSON.parse(text) as T;
}

beforeEach(() => {
  savedEnv = { ...process.env };
  temp = realpathSync(mkdtempSync(join(tmpdir(), 'orc-clean-repo-')));
  dataHome = join(temp, 'data');
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
  for (const child of providerProcesses.splice(0)) child.kill();
  process.env = savedEnv;
  vi.doUnmock('../adapters/index.ts');
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

    // ── Dispatch with the real coordinator, in project mode. ─────────────────
    process.env = cleanEnv({ ORC_PROJECT_ID: project.id });
    const providers = makeProviderSessions();
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => providers.adapter }));
    let coordinator = await import('../coordinator.ts');
    const { STATE_DIR, ACTIVE_PROJECT } = await import('../lib/paths.ts');
    expect(ACTIVE_PROJECT?.id).toBe(project.id);
    expect(STATE_DIR).toBe(project.stateDir);

    const claims = () => json<{ claims: Array<{ run_id: string; task_ref: string; agent_id: string; state: string }> }>(readFileSync(join(STATE_DIR, 'claims.json'), 'utf8')).claims;
    let started: ReturnType<typeof providers.startTasks> = [];
    for (let i = 0; i < 10 && started.length < 2; i += 1) {
      await coordinator.tick();
      started = [...started, ...providers.startTasks()];
    }
    expect(started).toHaveLength(2);
    expect(claims().filter((claim) => claim.state === 'in_progress').map((claim) => claim.task_ref).sort()).toEqual(['app/alpha', 'app/beta']);
    // Worktrees belong to the target repository but live in the external state directory.
    for (const item of started) {
      expect(item.worktree.startsWith(join(project.stateDir, 'worktrees'))).toBe(true);
      expect(realpathSync(git(item.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'))).toBe(join(target, '.git'));
      // The worker received the pinned revision body, not a repository file.
      expect(item.specPath.startsWith(join(project.stateDir, 'run-specs'))).toBe(true);
    }

    // ── Inspect and attach through the CLI and the TUI while both runs are active. ──
    const status = json<{ project: { id: string } }>(orcOk(['status', '--json']));
    expect(status.project.id).toBe(project.id);
    const active = json<{ project: { id: string }; runs: Array<{ run_id: string; task_status: string; spec_revision: number }> }>(orcOk(['runs-active', '--json']));
    expect(active.project.id).toBe(project.id);
    expect(active.runs.map((run) => run.task_status).sort()).toEqual(['in_progress', 'in_progress']);
    expect(active.runs.every((run) => run.spec_revision === 1)).toBe(true);
    const tui = orcOk(['watch', '--once']);
    expect(tui).toContain('demo');
    const attached = orc(['attach', started[0].agentId]);
    expect(attached.status).toBe(0);
    expect(`${attached.stderr}${attached.stdout}`).toContain(`project: demo (${project.id})`);
    expect(orcOk(['run-info', started[0].runId])).toContain(started[0].runId);

    // ── Restart the coordinator mid-run: the provider sessions outlive it. ───
    providers.completeTask(started[0]);
    vi.resetModules();
    coordinator = await import('../coordinator.ts');
    providers.completeTask(started[1]);
    for (let i = 0; i < 20; i += 1) {
      await coordinator.tick();
      providers.handleFollowUps();
      if (claims().every((claim) => claim.state === 'done')) break;
    }
    // No run was redispatched across the restart; both finished through the merge.
    expect(claims().map((claim) => [claim.run_id, claim.state]).sort()).toEqual(started.map((item) => [item.runId, 'done']).sort());

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
    const doctor = orc(['doctor', '--json']);
    expect(json<{ ok: boolean }>(doctor.stdout).ok, doctor.stdout).toBe(true);

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
  }, 180_000);
});
