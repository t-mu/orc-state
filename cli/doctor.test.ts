import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, openSync, ftruncateSync, closeSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import {
  bridgeProjectEnv, createTempStateDir, cleanupTempStateDir, seedState as seedProjectState,
} from '../test-fixtures/stateHelpers.ts';
import { ensureStateInitialized } from '../lib/stateInit.ts';
import { closeProjectTaskStores, initProjectTaskStore } from '../lib/projectTasks.ts';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, utimesSync } from 'node:fs';
import { startControlServer } from '../lib/controlServer.ts';
import { closeAllDatabases, initEventsDb } from '../lib/eventLog.ts';
import { readProcessStart } from '../lib/processIdentity.ts';
import { checkSandboxControlSocket, checkSandboxDependencies } from '../lib/sandboxDeps.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orch-doctor-cli-test-');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/doctor.ts', () => {
  it('warns, without failing, when the running coordinator loaded older code than is on disk', async () => {
    seedCleanState();
    initEventsDb(dir);
    const codeRoot = mkdtempSync(join(tmpdir(), 'orch-doctor-code-'));
    mkdirSync(join(codeRoot, 'lib'));
    writeFileSync(join(codeRoot, 'coordinator.ts'), '');
    const server = await startControlServer(dir, { codeRoot });
    // Async spawn: the server shares this process's event loop.
    const doctor = () => new Promise<{ code: number | null; json: { ok: boolean; checks: { coordinatorCode: { warning: string | null } } }; text: string }>((resolveRun) => {
      const run = (args: string[]) => new Promise<{ code: number | null; out: string }>((done) => {
        const child = spawn(process.execPath, ['cli/doctor.ts', ...args], { cwd: repoRoot, env: { ...process.env, ORC_STATE_DIR: dir } });
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
        child.on('close', (code) => done({ code, out }));
      });
      void Promise.all([run(['--json']), run([])]).then(([j, t]) => resolveRun({ code: j.code, json: JSON.parse(j.out), text: t.out }));
    });
    try {
      const fresh = await doctor();
      expect(fresh.json.checks.coordinatorCode.warning).toBeNull();
      const baseline = fresh.code;
      writeFileSync(join(codeRoot, 'lib', 'touched.ts'), '');
      const future = Date.now() / 1000 + 3600;
      utimesSync(join(codeRoot, 'lib', 'touched.ts'), future, future);
      const stale = await doctor();
      expect(stale.json.checks.coordinatorCode.warning).toMatch(/^coordinator is running code from .+; restart with orc start-session --restart-stale$/);
      expect(stale.text).toContain('restart with orc start-session');
      expect(stale.code).toBe(baseline);
    } finally {
      await server.close();
      closeAllDatabases();
      rmSync(codeRoot, { recursive: true, force: true });
    }
  });

  it('reports stale active claims with actionable hint', () => {
    seedState({
      agents: [{ agent_id: 'bob', provider: 'codex', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'bob',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00Z',
        task_envelope_sent_at: '2026-01-01T00:00:01Z',
        lease_expires_at: '2099-01-01T00:00:00Z',
      }],
    });
    const result = runCli(['--json', '--stale-start-ms=1']);
    const json = JSON.parse(result.stdout);
    expect(json.checks.staleActiveClaims.length).toBe(1);
    expect(json.checks.staleActiveClaims[0].hint).toContain('Check coordinator logs');
  });

  it('does not flag claimed runs as stale before task envelope delivery', () => {
    seedState({
      agents: [{ agent_id: 'bob', provider: 'codex', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'bob',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00Z',
        task_envelope_sent_at: null,
        lease_expires_at: '2099-01-01T00:00:00Z',
      }],
    });
    const result = runCli(['--json', '--stale-start-ms=1']);
    const json = JSON.parse(result.stdout);
    expect(json.checks.staleActiveClaims.length).toBe(0);
  });

  it('reports orphaned active claims', () => {
    seedState({
      agents: [],
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'missing',
        state: 'in_progress',
        claimed_at: '2026-01-01T00:00:00Z',
        started_at: '2026-01-01T00:01:00Z',
        lease_expires_at: '2099-01-01T00:00:00Z',
      }],
    });
    const result = runCli(['--json']);
    const json = JSON.parse(result.stdout);
    expect(json.checks.orphanedActiveClaims.length).toBe(1);
  });

  it('does not include legacy health-check keys in output', () => {
    seedState({ agents: [], claims: [] });
    const result = runCli(['--json']);
    const json = JSON.parse(result.stdout);
    expect(json.checks).not.toHaveProperty('tm' + 'uxAccess');
    expect(json.checks).not.toHaveProperty('provider' + 'Cli');
    expect(json.checks).not.toHaveProperty('providerApiKeys');
    expect(json.checks).not.toHaveProperty('providerSdkInstalled');
  });

  it('reports providerBinaries for each registered provider', () => {
    seedState({
      agents: [{ agent_id: 'claudia', provider: 'claude', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
      claims: [],
    });
    const result = runCli(['--json']);
    const json = JSON.parse(result.stdout);
    expect(json.checks).toHaveProperty('providerBinaries');
    expect(json.checks.providerBinaries).toHaveProperty('claude');
    expect(json.checks.providerBinaries.claude.binary).toBe('claude');
    expect(typeof json.checks.providerBinaries.claude.ok).toBe('boolean');
  });

  it('includes install hint for missing mapped provider binary', () => {
    seedState({
      agents: [{ agent_id: 'cody', provider: 'codex', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
      claims: [],
    });
    const result = runCli(['--json'], { ...process.env, PATH: '/definitely-not-real' });
    const json = JSON.parse(result.stdout);
    expect(json.checks.providerBinaries.codex.ok).toBe(false);
    expect(json.checks.providerBinaries.codex.detail).toContain('npm install -g @openai/codex');
  });

  it('reports lifecycle invariant issues in structured output', () => {
    seedState({
      agents: [{ agent_id: 'bob', provider: 'codex', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
      claims: [
        {
          run_id: 'run-new',
          task_ref: 'docs/task-1',
          agent_id: 'bob',
          state: 'in_progress',
          claimed_at: '2026-01-01T00:05:00Z',
          lease_expires_at: '2099-01-01T00:00:00Z',
          finalization_state: 'blocked_finalize',
        },
      ],
    });
    const result = runCli(['--json']);
    const json = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    expect(json.checks.lifecycleIssues.some((issue: Record<string, unknown>) => issue.code === 'missing_finalization_blocked_reason')).toBe(true);
  });

  it('reports state validation errors when events storage is missing', () => {
    seedState({ agents: [], claims: [] });
    // Remove the events file so doctor detects missing storage
    unlinkSync(join(dir, 'events.jsonl'));
    const result = runCli(['--json']);
    const json = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    expect(json.checks.stateErrors.some((error: string) => error.includes('events'))).toBe(true);
  });

  it('reports problem when not inside a git repository', () => {
    seedState({ agents: [], claims: [] });
    const tmpCwd = mkdtempSync(join(tmpdir(), 'orc-no-git-'));
    try {
      const result = spawnSync(
        process.execPath,
        [join(repoRoot, 'cli/doctor.ts'), '--json'],
        {
          cwd: tmpCwd,
          env: { ...process.env, ORC_STATE_DIR: dir },
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.checks.gitRepo).toBe(false);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});

describe('doctor tmux check', () => {
  function fakeTmux(versionOutput: string | null): string {
    const bin = join(dir, 'fake-tmux');
    writeFileSync(bin, versionOutput == null ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\necho '${versionOutput}'\n`, { mode: 0o755 });
    return bin;
  }

  it('reports an error when tmux is missing', () => {
    seedCleanState();
    const result = runCli(['--json'], { ...process.env, ORC_TMUX_BIN: join(dir, 'no-such-tmux') });
    const json = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    expect(json.checks.tmux).toMatchObject({ ok: false, version: null });
    expect(json.checks.tmux.problem).toContain('tmux is not installed');
  });

  it('reports an error for tmux older than 3.2', () => {
    seedCleanState();
    const result = runCli([], { ...process.env, ORC_TMUX_BIN: fakeTmux('tmux 3.1c') });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('tmux: ok=false version=tmux 3.1c');
    expect(result.stdout).toContain('error: tmux 3.1c is too old; orc needs tmux >= 3.2');
  });

  it('accepts tmux 3.2 and newer', () => {
    seedCleanState();
    const json = JSON.parse(runCli(['--json'], { ...process.env, ORC_TMUX_BIN: fakeTmux('tmux 3.3a') }).stdout);
    expect(json.checks.tmux).toEqual({ ok: true, version: 'tmux 3.3a', problem: null });
  });
});

describe('doctor on a registered project', () => {
  it('passes for a fresh project', () => {
    const target = mkdtempSync(join(tmpdir(), 'orc-doctor-target-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: target });
      ensureStateInitialized(dir);
      initProjectTaskStore(dir);
      closeProjectTaskStores();
      const result = spawnSync(process.execPath, ['cli/doctor.ts', '--json'], {
        cwd: repoRoot,
        env: { ...process.env, ...bridgeProjectEnv(dir, target) },
        encoding: 'utf8',
      });
      const json = JSON.parse(result.stdout);
      expect(result.status, result.stdout).toBe(0);
      expect(json.ok).toBe(true);
      expect(json.checks.projectSelection).toBeNull();
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('reports a live coordinator without a matching coordinator.pid', async () => {
    const target = mkdtempSync(join(tmpdir(), 'orc-doctor-target-'));
    const script = join(target, 'coordinator.js');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    const coordinator = spawn(process.execPath, [script], { stdio: 'ignore' });
    try {
      await new Promise<void>((resolve, reject) => { coordinator.once('spawn', resolve); coordinator.once('error', reject); });
      const pid = coordinator.pid!;
      spawnSync('git', ['init', '-q'], { cwd: target });
      ensureStateInitialized(dir);
      initProjectTaskStore(dir);
      closeProjectTaskStores();
      writeFileSync(join(dir, 'control.json'), JSON.stringify({
        protocol_version: 1, transport: 'unix', path: join(dir, 'control.sock'),
        pid, started_at: new Date().toISOString(), process_start: readProcessStart(pid),
      }));
      const doctor = () => {
        const result = spawnSync(process.execPath, ['cli/doctor.ts', '--json'], {
          cwd: repoRoot, env: { ...process.env, ...bridgeProjectEnv(dir, target) }, encoding: 'utf8',
        });
        return { status: result.status, json: JSON.parse(result.stdout) };
      };

      let { status, json } = doctor();
      expect(status).toBe(1);
      expect(json.checks.coordinatorLock.problem).toMatch(`coordinator PID ${pid} is running but`);
      expect(json.checks.coordinatorLock.problem).toMatch(/coordinator\.pid is missing/);

      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: 999999999, started_at: 'x' }));
      ({ status, json } = doctor());
      expect(status).toBe(1);
      expect(json.checks.coordinatorLock.problem).toMatch(/coordinator\.pid names PID 999999999/);

      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid, started_at: 'x', process_start: readProcessStart(pid) }));
      ({ status, json } = doctor());
      expect(json.checks.coordinatorLock.problem).toBeNull();
      expect(status, JSON.stringify(json)).toBe(0);
    } finally {
      coordinator.kill('SIGKILL');
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('ignores a leftover migration record from an earlier migration', () => {
    const target = mkdtempSync(join(tmpdir(), 'orc-doctor-target-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: target });
      ensureStateInitialized(dir);
      initProjectTaskStore(dir);
      closeProjectTaskStores();
      writeFileSync(join(dir, 'migration.json'), JSON.stringify({ status: 'importing', source_root: '/old/install' }));
      const result = spawnSync(process.execPath, ['cli/doctor.ts', '--json'], {
        cwd: repoRoot,
        env: { ...process.env, ...bridgeProjectEnv(dir, target) },
        encoding: 'utf8',
      });
      expect(result.status, result.stdout).toBe(0);
      expect(JSON.parse(result.stdout).ok).toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('doctor without a registered project', () => {
  it('fails and says how to register or select one', () => {
    writeStateFiles();
    const result = runCli(['--json']);
    const json = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    expect(json.checks.projectSelection.ok).toBe(false);
    expect(json.checks.projectSelection.message).toMatch(/No registered project here.*orc project add.*orc project select/);
  });
});

describe('doctor memory health', () => {
  it('reports memory not initialized when memory.db missing', () => {
    seedCleanState();
    const result = runCli(['--json']);
    const json = JSON.parse(result.stdout);
    expect(json.checks.memoryHealth.ok).toBe(true);
    expect(json.checks.memoryHealth.messages.some((m: string) => m.includes('not initialized'))).toBe(true);
  });

  it('validates memory.db schema when present', () => {
    seedCleanState();
    seedMemoryDb(dir);
    const result = runCli(['--json']);
    const json = JSON.parse(result.stdout);
    expect(json.checks.memoryHealth.ok).toBe(true);
    expect(json.checks.memoryHealth.messages.some((m: string) => m.includes('FTS5 integrity check passed'))).toBe(true);
  });

  it('detects FTS5 integrity issues', () => {
    seedCleanState();
    seedMemoryDb(dir, { corruptFts: true });
    const result = runCli(['--json']);
    const json = JSON.parse(result.stdout);
    expect(json.checks.memoryHealth.ok).toBe(false);
    expect(json.checks.memoryHealth.messages.some((m: string) => m.includes('FTS5 integrity check failed'))).toBe(true);
    expect(result.status).toBe(1);
  });

  it('warns when WAL file exceeds 50MB threshold', () => {
    seedCleanState();
    seedMemoryDb(dir);
    // Create a sparse WAL file > 50MB without writing actual data
    const walPath = join(dir, 'memory.db-wal');
    const fd = openSync(walPath, 'w');
    ftruncateSync(fd, 50 * 1024 * 1024 + 1);
    closeSync(fd);
    const result = runCli(['--json']);
    const json = JSON.parse(result.stdout);
    expect(json.checks.memoryHealth.ok).toBe(true);
    expect(json.checks.memoryHealth.messages.some((m: string) => m.includes('WAL file'))).toBe(true);
  });
});

describe('doctor sandbox dependencies', () => {
  it('checks for bwrap and socat on linux with claude sandbox', () => {
    const result = checkSandboxDependencies({
      platform: 'linux',
      env: { ORC_MASTER_PROVIDER: 'claude', ORC_MASTER_EXECUTION_MODE: 'sandbox' },
    });
    expect(result.skipped).toBe(false);
    // bwrap and socat may or may not be installed; just verify the shape
    expect(Array.isArray(result.missing)).toBe(true);
    expect(typeof result.ok).toBe('boolean');
  });

  it('skips check on macOS even when claude sandbox configured', () => {
    const result = checkSandboxDependencies({
      platform: 'darwin',
      env: { ORC_MASTER_PROVIDER: 'claude', ORC_MASTER_EXECUTION_MODE: 'sandbox' },
    });
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.reason).toContain('Seatbelt');
  });

  it('skips check when no sandbox configured', () => {
    const result = checkSandboxDependencies({
      platform: 'linux',
      env: { ORC_MASTER_PROVIDER: 'claude', ORC_MASTER_EXECUTION_MODE: 'full-access' },
    });
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.reason).toContain('no Claude sandbox configured');
  });

  it('skips check for codex sandbox (codex does not use bwrap)', () => {
    const result = checkSandboxDependencies({
      platform: 'linux',
      env: { ORC_MASTER_PROVIDER: 'codex', ORC_MASTER_EXECUTION_MODE: 'sandbox', ORC_WORKER_PROVIDER: 'codex', ORC_WORKER_EXECUTION_MODE: 'sandbox' },
    });
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.reason).toContain('no Claude sandbox configured');
  });
});

describe('doctor sandbox control socket (task 230)', () => {
  const check = (env: NodeJS.ProcessEnv, platform = 'linux', project = true) =>
    checkSandboxControlSocket({ platform, env, settings: {}, project }).warning;

  it('warns when sandboxed Codex or Linux Claude project workers cannot reach the socket', () => {
    expect(check({ ORC_WORKER_PROVIDER: 'codex', ORC_WORKER_EXECUTION_MODE: 'sandbox' })).toContain('worker_pool.sandbox_network');
    expect(check({ ORC_WORKER_PROVIDER: 'codex', ORC_WORKER_EXECUTION_MODE: 'sandbox' }, 'darwin')).toContain('the Codex sandbox');
    expect(check({ ORC_WORKER_PROVIDER: 'claude', ORC_WORKER_EXECUTION_MODE: 'sandbox' })).toContain("Claude's Linux sandbox");
  });

  it('stays quiet with the opt-in, on macOS Claude, in full-access, and outside a project', () => {
    expect(check({ ORC_WORKER_PROVIDER: 'codex', ORC_WORKER_EXECUTION_MODE: 'sandbox', ORC_WORKER_SANDBOX_NETWORK: 'open' })).toBeNull();
    expect(check({ ORC_WORKER_PROVIDER: 'claude', ORC_WORKER_EXECUTION_MODE: 'sandbox' }, 'darwin')).toBeNull();
    expect(check({ ORC_WORKER_PROVIDER: 'codex', ORC_WORKER_EXECUTION_MODE: 'full-access' })).toBeNull();
    expect(check({ ORC_WORKER_PROVIDER: 'codex', ORC_WORKER_EXECUTION_MODE: 'sandbox' }, 'linux', false)).toBeNull();
  });
});

function runCli(args: string[], env = process.env) {
  return spawnSync(process.execPath, ['cli/doctor.ts', ...args], {
    cwd: repoRoot,
    env: { ...env, ORC_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedCleanState() {
  seedProjectState(dir);
}

function writeStateFiles() {
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function seedMemoryDb(stateDir: string, opts: { corruptFts?: boolean } = {}) {
  const dbPath = join(stateDir, 'memory.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS drawers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wing TEXT NOT NULL,
      hall TEXT NOT NULL,
      room TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT,
      importance INTEGER NOT NULL DEFAULT 5,
      source_type TEXT,
      source_ref TEXT,
      agent_id TEXT,
      tags TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS drawers_fts USING fts5(
      content, tags, wing, hall, room,
      content='drawers', content_rowid='id'
    );
  `);
  if (opts.corruptFts) {
    // Drop the FTS table to simulate corruption by removing it entirely,
    // then recreate it as a plain (non-virtual) table to break FTS5 integrity
    db.exec(`DROP TABLE drawers_fts`);
    db.exec(`CREATE TABLE drawers_fts (content TEXT)`);
  }
  db.close();
}

function seedState({ agents = [] as unknown[], claims = [] as unknown[] } = {}) {
  seedProjectState(dir, { tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'claimed' }], agents, claims });
}
