import { describe, it, expect, vi, afterEach } from 'vitest';
import { cliError, formatErrorMessage, loadClaim } from './shared.ts';

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
});
