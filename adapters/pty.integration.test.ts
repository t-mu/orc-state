import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { detectPtySupport } from '../test-fixtures/ptySupport.ts';

let stateDir: string;
let originalPath: string | undefined;
const PTY_SUPPORTED = detectPtySupport();
const fixtureBin = resolve(import.meta.dirname, '..', 'test-fixtures', 'bin');

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
  stateDir = createTempStateDir('orc-pty-int-');
  process.env.ORC_STATE_DIR = stateDir;
  originalPath = process.env.PATH;
});

afterEach(() => {
  cleanupTempStateDir(stateDir);
  delete process.env.ORC_STATE_DIR;
  process.env.PATH = originalPath;
});

async function withFixturePath<T>(run: () => Promise<T>): Promise<T> {
  const previousPath = process.env.PATH;
  process.env.PATH = `${fixtureBin}:${previousPath ?? ''}`;
  try {
    return await run();
  } finally {
    process.env.PATH = previousPath ?? '';
  }
}

describe.runIf(PTY_SUPPORTED)('adapters/pty.ts integration', () => {
  it('real PTY lifecycle: start -> send -> probe -> exit -> stop', async () => {
    const { createPtyAdapter } = await import('./pty.ts');
    const adapter = createPtyAdapter({ provider: 'claude' });

    const started = await withFixturePath(() => adapter.start('worker-01', { system_prompt: 'PING' }));
    expect(started.session_handle).toBe('pty:worker-01');

    const pidFile = join(stateDir, 'pty-pids', 'worker-01.pid');
    const logFile = join(stateDir, 'pty-logs', 'worker-01.log');
    expect(existsSync(pidFile)).toBe(true);
    expect(existsSync(logFile)).toBe(true);

    await waitFor(() => {
      const log = readFileSync(logFile, 'utf8');
      return log.includes('FIXTURE_READY provider=claude') && log.includes('FIXTURE_PONG');
    }, { message: 'initial startup and bootstrap PING markers not found' });

    await adapter.send('pty:worker-01', 'PING');

    await waitFor(() => {
      const log = readFileSync(logFile, 'utf8');
      const pongCount = (log.match(/FIXTURE_PONG/g) ?? []).length;
      return pongCount >= 2;
    }, { message: 'second FIXTURE_PONG not found after send()' });

    await expect(adapter.heartbeatProbe('pty:worker-01')).resolves.toBe(true);

    await adapter.send('pty:worker-01', 'EXIT');
    await waitFor(async () => (await adapter.heartbeatProbe('pty:worker-01')) === false, {
      message: 'heartbeatProbe did not transition to false after EXIT',
    });

    await expect(adapter.stop('pty:worker-01')).resolves.toBeUndefined();
    await expect(adapter.stop('pty:worker-01')).resolves.toBeUndefined();
    expect(existsSync(pidFile)).toBe(false);
  });

  it('heartbeatProbe returns false for malformed handle', async () => {
    const { createPtyAdapter } = await import('./pty.ts');
    const adapter = createPtyAdapter({ provider: 'claude' });
    await expect(adapter.heartbeatProbe('not-a-pty-handle')).resolves.toBe(false);
  });

  it('stop is no-op for unknown handle', async () => {
    const { createPtyAdapter } = await import('./pty.ts');
    const adapter = createPtyAdapter({ provider: 'claude' });
    await expect(adapter.stop('pty:missing-worker')).resolves.toBeUndefined();
  });
});

describe.runIf(!PTY_SUPPORTED)('adapters/pty.ts integration (unsupported)', () => {
  it('skips because PTY is unavailable in this environment', () => {
    expect(true).toBe(true);
  });
});

describe('adapters/pty.ts integration env hygiene', () => {
  it('restores PATH after fixture-path helper', async () => {
    const before = process.env.PATH;
    let during: string | undefined;
    await withFixturePath(() => {
      during = process.env.PATH;
      return Promise.resolve();
    });
    expect(during!.startsWith(`${fixtureBin}:`)).toBe(true);
    expect(process.env.PATH).toBe(before);
  });
});
