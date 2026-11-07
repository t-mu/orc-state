import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bridgeProjectEnv, createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { projectCliEnv } from '../test-fixtures/projectCli.ts';
import { spawn, spawnSync } from 'node:child_process';
import { readProcessStart } from '../lib/processIdentity.ts';
import { startFakeCoordinator } from '../test-fixtures/fakeCoordinator.ts';

const repoRoot = resolve(import.meta.dirname, '..');

let dir: string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  dir = createTempStateDir('orch-kill-all-test-');
});

afterEach(() => {
  process.env.ORC_PROJECT_ID = '';
  delete process.env.ORC_STATE_DIR;
  cleanupTempStateDir(dir);
});

// ── Helpers ────────────────────────────────────────────────────────────────

function seedState(agents: unknown[] = []) {
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents }));
}

function agentRecord(overrides = {}) {
  return {
    agent_id:       'bob',
    provider:       'claude',
    role:           'worker',
    status:         'running',
    session_handle: 'claude:s1',
    provider_ref:   {},
    model:          null,
    registered_at:  '2026-01-01T00:00:00Z',
    last_heartbeat_at: null,
    last_status_change_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function readAgents() {
  return JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')).agents;
}

function setEnv(stateDir: string) {
  Object.assign(process.env, bridgeProjectEnv(stateDir));
}

function spawnKillAll(stateDir: string, extraArgs: string[] = []) {
  return spawnSync('node', ['cli/kill-all.ts', ...extraArgs], {
    cwd:      repoRoot,
    env:      projectCliEnv(stateDir),
    encoding: 'utf8',
  });
}

/** spawnSync would block this process, so a child it spawned could not report its exit. */
function spawnKillAllAsync(stateDir: string): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['cli/kill-all.ts'], { cwd: repoRoot, env: projectCliEnv(stateDir) });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout }));
  });
}

function writeEndpoint(pid: number, processStart: string | null) {
  writeFileSync(join(dir, 'control.json'), JSON.stringify({
    protocol_version: 1, transport: 'unix', path: join(dir, 'control.sock'),
    pid, started_at: '2026-11-01T00:00:00.000Z', process_start: processStart,
  }));
}

// ── spawnSync tests (no adapter needed) ────────────────────────────────────

describe('cli/kill-all.ts', () => {
  describe('outside a registered project', () => {
    it('refuses and stops nothing', () => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORC_')));
      const result = spawnSync('node', ['cli/kill-all.ts'], {
        cwd: repoRoot, encoding: 'utf8',
        env: { ...env, ORC_DATA_HOME: '/nonexistent/orc-test-data-home', ORC_STATE_DIR: join(dir, 'legacy') },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('No registered project here');
      expect(result.stdout).not.toContain('Cleared');
    });
  });

  describe('coordinator handling', () => {
    it('prints "not running" when coordinator.pid is absent', () => {
      seedState();
      const result = spawnKillAll(dir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('not running');
    });

    it('prints "already stopped" when pid file contains a dead PID', () => {
      seedState();
      // PID 1 is always running (launchd) but we cannot SIGTERM it;
      // use a very large pid that is almost certainly dead.
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: 9999999 }));
      const result = spawnKillAll(dir);
      expect(result.status).toBe(0);
      // Either "already stopped" or a warning — must not crash
      expect(result.stdout + result.stderr).toMatch(/already stopped|Warning/);
    });

    it('removes stale coordinator.pid when pid is dead', () => {
      seedState();
      const pidFile = join(dir, 'coordinator.pid');
      writeFileSync(pidFile, JSON.stringify({ pid: 9999999 }));

      const result = spawnKillAll(dir);

      expect(result.status).toBe(0);
      expect(existsSync(pidFile)).toBe(false);
    });

    it('never signals a reused PID: a lock whose process start no longer matches is stale', () => {
      seedState();
      const pidFile = join(dir, 'coordinator.pid');
      // This test's own (live) process, recorded with another start time, stands in for a reused PID.
      writeFileSync(pidFile, JSON.stringify({ pid: process.pid, process_start: 'proc:0' }));

      const result = spawnKillAll(dir);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('already stopped');
      expect(existsSync(pidFile)).toBe(false);
    });

    it('stops a live coordinator recorded only in control.json', async () => {
      seedState();
      const coordinator = await startFakeCoordinator();
      try {
        const exited = new Promise<NodeJS.Signals | null>((resolve) => coordinator.child.once('exit', (_code, signal) => resolve(signal)));
        writeEndpoint(coordinator.pid, readProcessStart(coordinator.pid));

        const result = await spawnKillAllAsync(dir);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`Coordinator stopped  (PID ${coordinator.pid}, found via control.json`);
        expect(await exited).toBe('SIGTERM');
      } finally {
        await coordinator.stop();
      }
    });

    it('never signals a control.json PID that is dead or reused by a non-coordinator', () => {
      seedState();
      // This test's own (live) process is not a coordinator.
      writeEndpoint(process.pid, readProcessStart(process.pid));
      expect(spawnKillAll(dir).stdout).toContain('Coordinator not running');
      writeEndpoint(999999999, 'proc:1');
      expect(spawnKillAll(dir).stdout).toContain('Coordinator not running');
    });

    it('prints "not running" when pid file exists but contains no pid', () => {
      seedState();
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({}));
      const result = spawnKillAll(dir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('not running');
    });
  });

  describe('agent registry clearing', () => {
    it('clears agents.json to an empty agents array', () => {
      seedState([agentRecord({ session_handle: null })]);
      const result = spawnKillAll(dir);
      expect(result.status).toBe(0);
      expect(readAgents()).toEqual([]);
    });

    it('reports the count of cleared agents', () => {
      seedState([agentRecord({ agent_id: 'a', session_handle: null }), agentRecord({ agent_id: 'b', session_handle: null })]);
      const result = spawnKillAll(dir);
      expect(result.stdout).toContain('Cleared 2');
    });

    it('reports "Cleared 0" when registry was already empty', () => {
      seedState([]);
      const result = spawnKillAll(dir);
      expect(result.stdout).toContain('Cleared 0');
    });
  });

  // ── vi.doMock + dynamic import tests ─────────────────────────────────────

  describe('session teardown', () => {
    it('calls adapter.stop for each agent with a session_handle', async () => {
      seedState([
        agentRecord({ agent_id: 'alice', session_handle: 'claude:s1' }),
        agentRecord({ agent_id: 'bob',   session_handle: 'claude:s2' }),
      ]);

      const stop = vi.fn().mockResolvedValue(undefined);
      vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => ({ stop }) }));

      setEnv(dir);
      process.argv = ['node', 'kill-all.ts'];
      await import('./kill-all.ts');

      expect(stop).toHaveBeenCalledTimes(2);
    });

    it('stops a tmux master and revokes its credential (v1/master-tmux)', async () => {
      seedState([agentRecord({ agent_id: 'master', role: 'master', session_handle: 'tmux:master' })]);
      const { initEventsDb } = await import('../lib/eventLog.ts');
      initEventsDb(dir);
      const { recordProviderSession } = await import('../lib/runStore.ts');
      recordProviderSession(dir, {
        sessionId: 'session-master', runId: null, agentId: 'master', provider: 'claude', providerRef: null,
        startedAt: '2026-01-01T00:00:00.000Z', transport: 'tmux', credentialHash: 'hash',
      });

      const stop = vi.fn().mockResolvedValue(undefined);
      vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => ({ stop }) }));

      setEnv(dir);
      process.argv = ['node', 'kill-all.ts'];
      await import('./kill-all.ts');

      expect(stop).toHaveBeenCalledWith('tmux:master');
      const { listSupervisedSessions } = await import('../lib/sessionSupervisor.ts');
      expect(listSupervisedSessions(dir).find((row) => row.session_id === 'session-master')?.state).toBe('offline');
    });

    it('skips adapter.stop for agents without a session_handle', async () => {
      seedState([agentRecord({ agent_id: 'idle', session_handle: null })]);

      const stop = vi.fn();
      vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => ({ stop }) }));

      setEnv(dir);
      process.argv = ['node', 'kill-all.ts'];
      await import('./kill-all.ts');

      expect(stop).not.toHaveBeenCalled();
    });

    it('skips adapter.stop when --keep-sessions is passed', async () => {
      seedState([agentRecord({ agent_id: 'alice', session_handle: 'claude:s1' })]);

      const stop = vi.fn();
      vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => ({ stop }) }));

      setEnv(dir);
      process.argv = ['node', 'kill-all.ts', '--keep-sessions'];
      await import('./kill-all.ts');

      expect(stop).not.toHaveBeenCalled();
    });

    it('continues and exits 0 when adapter.stop throws for one agent', async () => {
      seedState([
        agentRecord({ agent_id: 'alice', session_handle: 'claude:s1' }),
        agentRecord({ agent_id: 'bob',   session_handle: 'claude:s2' }),
      ]);

      const stop = vi.fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce(undefined);
      vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => ({ stop }) }));

      const warnLines: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...args) => warnLines.push(args.join(' ')));

      setEnv(dir);
      process.argv = ['node', 'kill-all.ts'];
      await import('./kill-all.ts');

      // Both agents attempted
      expect(stop).toHaveBeenCalledTimes(2);
      // Warning printed for the failing one
      expect(warnLines.some((l) => l.includes('Warning') && l.includes('alice'))).toBe(true);
      // Registry still cleared
      expect(readAgents()).toEqual([]);
    });
  });

  describe('coordinator SIGTERM', () => {
    it('sends SIGTERM to the coordinator PID when alive', async () => {
      seedState();
      const coordinator = await startFakeCoordinator();
      onTestFinished(() => coordinator.stop());
      const livePid = coordinator.pid;
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: livePid }));

      const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, _sig) => {
        return true; // liveness check or SIGTERM: don't actually kill ourselves
      });

      vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => ({ stop: vi.fn() }) }));

      setEnv(dir);
      process.argv = ['node', 'kill-all.ts'];
      await import('./kill-all.ts');

      const sigtermCalls = killSpy.mock.calls.filter(([, sig]) => sig === 'SIGTERM');
      expect(sigtermCalls.length).toBeGreaterThan(0);
      expect(sigtermCalls[0][0]).toBe(livePid);
    });
  });
});
