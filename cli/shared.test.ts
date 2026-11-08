import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cliError, formatErrorMessage, loadClaim, printJson } from './shared.ts';

const SHARED_PATH = fileURLToPath(new URL('./shared.ts', import.meta.url));

/** Runs a snippet in a child Node process whose stdout is a pipe, as it is for `orc status --json | jq`. */
function runPiped(body: string) {
  const script = `import { printJson, exitAfterFlush } from ${JSON.stringify(SHARED_PATH)};\n${body}`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cli/shared.ts', () => {
  describe('formatErrorMessage', () => {
    it('returns message from an Error object', () => {
      const err = new Error('something went wrong');
      expect(formatErrorMessage(err)).toBe('something went wrong');
    });

    it('returns string representation for non-Error values', () => {
      expect(formatErrorMessage('raw string')).toBe('raw string');
      expect(formatErrorMessage(42)).toBe('42');
      expect(formatErrorMessage(null)).toBe('null');
    });
  });

  describe('cliError', () => {
    it('logs Error: prefix followed by message and exits 1', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
        throw new Error('process.exit called');
      });

      expect(() => cliError(new Error('bad thing happened'))).toThrow('process.exit called');
      expect(consoleSpy).toHaveBeenCalledWith('Error: bad thing happened');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('handles non-Error values', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
        throw new Error('process.exit called');
      });

      expect(() => cliError('plain string error')).toThrow('process.exit called');
      expect(consoleSpy).toHaveBeenCalledWith('Error: plain string error');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('loadClaim', () => {
    it('returns null when STATE_DIR contains no claims.json', () => {
      // loadClaim reads from the module-level STATE_DIR constant;
      // in tests without a real state dir it will catch the ENOENT and return null.
      const claim = loadClaim('run-that-does-not-exist');
      expect(claim).toBeNull();
    });
  });

  describe('printJson and exitAfterFlush', () => {
    it('indents json when stdout is a TTY and compacts it otherwise', () => {
      const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        printJson({ a: 1 });
        expect(write).toHaveBeenLastCalledWith('{\n  "a": 1\n}\n');

        Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
        printJson({ a: 1 });
        expect(write).toHaveBeenLastCalledWith('{"a":1}\n');
      } finally {
        if (original) Object.defineProperty(process.stdout, 'isTTY', original);
        else delete (process.stdout as { isTTY?: boolean }).isTTY;
      }
    });

    it('prints one compact line when stdout is piped', () => {
      const result = runPiped("printJson({ a: 1, nested: { b: [1, 2] } });");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('{"a":1,"nested":{"b":[1,2]}}\n');
    });

    it('delivers a piped payload larger than 64 KB intact before exiting', () => {
      const result = runPiped(`
        const items = Array.from({ length: 4000 }, (_, i) => ({ i, pad: 'x'.repeat(40) }));
        printJson({ items });
        await exitAfterFlush(0);
        console.log('NOT REACHED');
      `);
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('NOT REACHED');
      expect(result.stdout.length).toBeGreaterThan(64 * 1024);
      const parsed = JSON.parse(result.stdout) as { items: Array<{ i: number }> };
      expect(parsed.items).toHaveLength(4000);
      expect(parsed.items.at(-1)?.i).toBe(3999);
    });
  });
});
