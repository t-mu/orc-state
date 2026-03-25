import { describe, expect, it } from 'vitest';
import { startMasterPtyForwarder, stripAnsi } from './masterPtyForwarder.ts';

describe('startMasterPtyForwarder', () => {
  it('is a no-op and returns a stop function', () => {
    const stop = startMasterPtyForwarder('/tmp/fake', null, null);
    expect(typeof stop).toBe('function');
    // stop function must not throw
    expect(() => stop()).not.toThrow();
  });
});

describe('stripAnsi', () => {
  it('removes ANSI escape sequences', () => {
    expect(stripAnsi('\x1b[32mhello\x1b[0m')).toBe('hello');
  });

  it('returns a plain string unchanged', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});
