import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';
import { detectPtySupport } from '../test-fixtures/ptySupport.ts';
import type { createPtyAdapter } from '../adapters/pty.ts';

const repoRoot = resolve(import.meta.dirname, '..');
const fixtureBinPath = resolve(import.meta.dirname, '..', 'test-fixtures', 'bin');
const PTY_SUPPORTED = detectPtySupport();
let stateDir: string;
let adapter: ReturnType<typeof createPtyAdapter> | undefined;
let sessionHandle: string | undefined;
let originalPath: string | undefined;

function sleep(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, { timeoutMs = 5000, intervalMs = 50, message = 'condition not met' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms: ${message}`);
}

beforeEach(() => {
  vi.resetModules();
  stateDir = createTempStateDir('orc-control-worker-int-');
  process.env.ORCH_STATE_DIR = stateDir;
  originalPath = process.env.PATH ?? '';
});

afterEach(async () => {
  if (adapter && sessionHandle) {
    try {
      await adapter.stop(sessionHandle);
    } catch {
      // no-op in cleanup
    }
  }
  adapter = undefined as unknown as ReturnType<typeof createPtyAdapter>;
  sessionHandle = undefined as unknown as string;
  cleanupTempStateDir(stateDir);
  delete process.env.ORCH_STATE_DIR;
  process.env.PATH = originalPath;
});

async function withFixturePath<T>(run: () => Promise<T>): Promise<T> {
  const previousPath = process.env.PATH;
  process.env.PATH = `${fixtureBinPath}:${previousPath ?? ''}`;
  try {
    return await run() as T;
  } finally {
    process.env.PATH = previousPath;
  }
}

async function seedLiveWorkerSession(agentId = 'orc-1') {
  const { createPtyAdapter } = await import('../adapters/pty.ts');
  adapter = createPtyAdapter({ provider: 'claude' });
  const started = await withFixturePath(() => adapter!.start(agentId, { system_prompt: 'PING' }));
  sessionHandle = (started as { session_handle: string }).session_handle;

  writeFileSync(join(stateDir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{
      agent_id: agentId,
      provider: 'claude',
      role: 'worker',
      status: 'running',
      session_handle: sessionHandle,
      provider_ref: (started as { provider_ref: unknown }).provider_ref,
      registered_at: '2026-01-01T00:00:00.000Z',
      last_heartbeat_at: null,
    }],
  }));

  const logFile = join(stateDir, 'pty-logs', `${agentId}.log`);
  await waitFor(() => {
    if (!existsSync(logFile)) return false;
    const log = readFileSync(logFile, 'utf8');
    return log.includes('FIXTURE_READY provider=claude') && log.includes('FIXTURE_PONG');
  }, { message: 'fixture readiness marker not found in pty log' });
}

describe.runIf(PTY_SUPPORTED)('cli/control-worker.ts integration', () => {
  it('attaches to live worker PTY and prints log marker', async () => {
    await seedLiveWorkerSession('orc-1');

    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'cli/control-worker.ts', 'orc-1'], {
      cwd: repoRoot,
      env: { ...process.env, ORCH_STATE_DIR: stateDir, PATH: `${fixtureBinPath}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain('Attaching to worker orc-1');
    expect(output).toContain('FIXTURE_READY provider=claude');
    expect(output).toContain('Log file:');
  });

  it('exits 1 when worker PTY is unreachable', async () => {
    await seedLiveWorkerSession('orc-2');
    await adapter!.send('pty:orc-2', 'EXIT');
    await waitFor(async () => (await adapter!.heartbeatProbe('pty:orc-2')) === false, {
      timeoutMs: 10_000,
      message: 'session did not terminate after EXIT',
    });

    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'cli/control-worker.ts', 'orc-2'], {
      cwd: repoRoot,
      env: { ...process.env, ORCH_STATE_DIR: stateDir, PATH: `${fixtureBinPath}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not reachable');
    expect(result.stderr).toContain('--force-rebind');
  }, 15_000);
});

describe.runIf(!PTY_SUPPORTED)('cli/control-worker.ts integration (unsupported)', () => {
  it('skips because PTY is unavailable in this environment', () => {
    expect(true).toBe(true);
  });
});
