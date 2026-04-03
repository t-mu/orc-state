import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installAgents, type InstallResult } from './install-agents.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('installAgents', () => {
  it('returns copied file list on dry-run', () => {
    const base = mkdtempSync(join(tmpdir(), 'install-agents-test-'));
    const result: InstallResult = installAgents(['claude'], base, true);
    expect(result).toHaveProperty('copied');
    expect(result).toHaveProperty('count');
    expect(Array.isArray(result.copied)).toBe(true);
    expect(result.count).toBe(result.copied.length);
    expect(result.count).toBeGreaterThan(0);
  });

  it('returns count matching copied array length', () => {
    const base = mkdtempSync(join(tmpdir(), 'install-agents-test-'));
    const result = installAgents(['claude', 'codex'], base, true);
    expect(result.count).toBe(result.copied.length);
  });

  it('skips unsupported gemini install targets with a warning', () => {
    const base = mkdtempSync(join(tmpdir(), 'install-agents-test-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = installAgents(['gemini'], base, true);
    expect(result).toEqual({ copied: [], count: 0 });
    expect(warn).toHaveBeenCalledWith('Skipping agent installation for unsupported provider target(s): gemini.');
  });
});
