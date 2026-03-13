import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const fixturePath = resolve(import.meta.dirname, 'fake-provider-cli.ts');
const fixtureBinPath = resolve(import.meta.dirname, 'bin');

function waitForLine(stream: NodeJS.ReadableStream, predicate: (line: string) => boolean, timeoutMs = 2000) {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`Timed out waiting for line matching predicate. Buffer: ${buffer}`));
    }, timeoutMs);

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (predicate(line)) {
          cleanup();
          resolvePromise(line);
          return;
        }
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
    };

    stream.on('data', onData);
  });
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 2000) {
  return new Promise<number | null>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error('Timed out waiting for child process exit'));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
}

describe('test-fixtures/fake-provider-cli.ts', () => {
  it('handles PING then EXIT with exact markers', async () => {
    const child = spawn(process.execPath, ['--experimental-strip-types', fixturePath, 'claude'], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    await expect(waitForLine(child.stdout!, (line) => line === 'FIXTURE_READY provider=claude')).resolves.toBe('FIXTURE_READY provider=claude');

    child.stdin!.write('PING\n');
    await expect(waitForLine(child.stdout!, (line) => line === 'FIXTURE_PONG')).resolves.toBe('FIXTURE_PONG');

    child.stdin!.write('EXIT\n');
    await expect(waitForLine(child.stdout!, (line) => line === 'FIXTURE_BYE')).resolves.toBe('FIXTURE_BYE');
    await expect(waitForExit(child)).resolves.toBe(0);
  });

  it('exits 42 when FAKE_PROVIDER_CRASH_ON_START=1', async () => {
    const child = spawn(process.execPath, ['--experimental-strip-types', fixturePath, 'codex'], {
      cwd: repoRoot,
      env: { ...process.env, FAKE_PROVIDER_CRASH_ON_START: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    await expect(waitForLine(child.stderr!, (line) => line === 'FIXTURE_CRASH_ON_START')).resolves.toBe('FIXTURE_CRASH_ON_START');
    await expect(waitForExit(child)).resolves.toBe(42);
  });

  it('claude/codex/gemini wrappers all invoke shared fixture', async () => {
    for (const provider of ['claude', 'codex', 'gemini']) {
      const child = spawn(provider, [], {
        cwd: repoRoot,
        env: { ...process.env, PATH: `${fixtureBinPath}:${process.env.PATH ?? ''}` },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      await expect(waitForLine(child.stdout!, (line) => line === `FIXTURE_READY provider=${provider}`)).resolves.toBe(`FIXTURE_READY provider=${provider}`);
      child.stdin!.write('EXIT\n');
      await expect(waitForLine(child.stdout!, (line) => line === 'FIXTURE_BYE')).resolves.toBe('FIXTURE_BYE');
      await expect(waitForExit(child)).resolves.toBe(0);
    }
  });
});
