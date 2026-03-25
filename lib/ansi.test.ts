import { describe, expect, it } from 'vitest';
import { stripAnsi } from './ansi.ts';

describe('stripAnsi', () => {
  it('removes ANSI escape sequences', () => {
    expect(stripAnsi('\x1b[32mhello\x1b[0m')).toBe('hello');
  });

  it('returns a plain string unchanged', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});
