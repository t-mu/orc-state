import { describe, it, expect } from 'vitest';
import { flag, intFlag, flagAll } from './args.ts';

describe('flag', () => {
  it('returns null when missing', () => {
    expect(flag('missing', ['--foo=bar'])).toBeNull();
  });

  it('returns value when present', () => {
    expect(flag('foo', ['--foo=bar'])).toBe('bar');
  });

  it('preserves equals signs in value', () => {
    expect(flag('foo', ['--foo=a=b=c'])).toBe('a=b=c');
  });
});

describe('intFlag', () => {
  it('returns default when missing', () => {
    expect(intFlag('timeout', 30, ['--foo=bar'])).toBe(30);
  });

  it('returns parsed positive integer', () => {
    expect(intFlag('timeout', 30, ['--timeout=42'])).toBe(42);
  });

  it('returns default for zero/negative/invalid values', () => {
    expect(intFlag('timeout', 30, ['--timeout=0'])).toBe(30);
    expect(intFlag('timeout', 30, ['--timeout=-1'])).toBe(30);
    expect(intFlag('timeout', 30, ['--timeout=abc'])).toBe(30);
  });
});

describe('flagAll', () => {
  it('returns empty array when missing', () => {
    expect(flagAll('ac', ['--foo=bar'])).toEqual([]);
  });

  it('collects repeated flags in order', () => {
    expect(flagAll('ac', ['--ac=first', '--foo=bar', '--ac=second'])).toEqual(['first', 'second']);
  });

  it('preserves equals signs in repeated values', () => {
    expect(flagAll('ac', ['--ac=a=b', '--ac=c=d'])).toEqual(['a=b', 'c=d']);
  });
});
