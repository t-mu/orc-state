import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installSkills, type InstallResult } from './install-skills.ts';

describe('installSkills', () => {
  it('returns copied file list on dry-run', () => {
    const base = mkdtempSync(join(tmpdir(), 'install-skills-test-'));
    const result: InstallResult = installSkills(['claude'], base, true);
    expect(result).toHaveProperty('copied');
    expect(result).toHaveProperty('count');
    expect(Array.isArray(result.copied)).toBe(true);
    expect(result.count).toBe(result.copied.length);
    expect(result.count).toBeGreaterThan(0);
  });

  it('returns count matching copied array length', () => {
    const base = mkdtempSync(join(tmpdir(), 'install-skills-test-'));
    const result = installSkills(['claude', 'codex'], base, true);
    expect(result.count).toBe(result.copied.length);
  });
});
