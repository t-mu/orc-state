import { describe, it, expect } from 'vitest';
import { detectPtySupport } from './ptySupport.ts';

describe('test-fixtures/ptySupport.ts', () => {
  it('returns false when probe fails and strict mode is disabled', () => {
    const result = detectPtySupport({
      strict: false,
      probe: () => false,
    });
    expect(result).toBe(false);
  });

  it('throws when probe fails and strict mode is enabled', () => {
    expect(() => detectPtySupport({
      strict: true,
      probe: () => false,
    })).toThrow(/ORC_STRICT_PTY_TESTS=1/);
  });

  it('returns true when probe succeeds in strict mode', () => {
    const result = detectPtySupport({
      strict: true,
      probe: () => true,
    });
    expect(result).toBe(true);
  });

  it('returns true when force override is enabled', () => {
    const result = detectPtySupport({
      strict: true,
      force: true,
      probe: () => false,
    });
    expect(result).toBe(true);
  });
});
