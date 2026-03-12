import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync,
} from 'node:fs';
import { tmpdir }        from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync }     from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');

let dir;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'orch-kill-all-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function seedState(agents = []) {
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
    capabilities:   [],
    model:          null,
    dispatch_mode:  null,
    registered_at:  '2026-01-01T00:00:00Z',
    last_heartbeat_at: null,
    last_status_change_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function readAgents() {
  return JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')).agents;
}

function setEnv(stateDir) {
  process.env.ORCH_STATE_DIR = stateDir;
}

function spawnKillAll(stateDir, extraArgs = []) {
  return spawnSync('node', ['cli/kill-all.mjs', ...extraArgs], {
    cwd:      repoRoot,
    env:      { ...process.env, ORCH_STATE_DIR: stateDir },
    encoding: 'utf8',
  });
}

// ── spawnSync tests (no adapter needed) ────────────────────────────────────

describe('cli/kill-all.mjs', () => {
  describe('when state dir is absent', () => {
    it('exits 0 and prints "not running" and "Cleared 0"', () => {
      const missingDir = join(dir, 'does-not-exist');
      const result = spawnKillAll(missingDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('not running');
      expect(result.stdout).toContain('Cleared 0');
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
      vi.doMock('../adapters/index.mjs', () => ({ createAdapter: () => ({ stop }) }));

      setEnv(dir);
      process.argv = ['node', 'kill-all.mjs'];
      await import('./kill-all.mjs');

      expect(stop).toHaveBeenCalledTimes(2);
    });

    it('skips adapter.stop for agents without a session_handle', async () => {
      seedState([agentRecord({ agent_id: 'idle', session_handle: null })]);

      const stop = vi.fn();
      vi.doMock('../adapters/index.mjs', () => ({ createAdapter: () => ({ stop }) }));

      setEnv(dir);
      process.argv = ['node', 'kill-all.mjs'];
      await import('./kill-all.mjs');

      expect(stop).not.toHaveBeenCalled();
    });

    it('skips adapter.stop when --keep-sessions is passed', async () => {
      seedState([agentRecord({ agent_id: 'alice', session_handle: 'claude:s1' })]);

      const stop = vi.fn();
      vi.doMock('../adapters/index.mjs', () => ({ createAdapter: () => ({ stop }) }));

      setEnv(dir);
      process.argv = ['node', 'kill-all.mjs', '--keep-sessions'];
      await import('./kill-all.mjs');

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
      vi.doMock('../adapters/index.mjs', () => ({ createAdapter: () => ({ stop }) }));

      const warnLines = [];
      vi.spyOn(console, 'error').mockImplementation((...args) => warnLines.push(args.join(' ')));

      setEnv(dir);
      process.argv = ['node', 'kill-all.mjs'];
      await import('./kill-all.mjs');

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
      const livePid = process.pid; // current process is guaranteed alive
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: livePid }));

      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
        if (sig === 0) return; // liveness check: don't throw
        // On SIGTERM, don't actually kill ourselves — just record it
      });

      vi.doMock('../adapters/index.mjs', () => ({ createAdapter: () => ({ stop: vi.fn() }) }));

      setEnv(dir);
      process.argv = ['node', 'kill-all.mjs'];
      await import('./kill-all.mjs');

      const sigtermCalls = killSpy.mock.calls.filter(([, sig]) => sig === 'SIGTERM');
      expect(sigtermCalls.length).toBeGreaterThan(0);
      expect(sigtermCalls[0][0]).toBe(livePid);
    });
  });
});
