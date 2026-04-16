import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { installSkills, type InstallResult } from './install-skills.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('installs only real skills and excludes workspace/eval artifacts', () => {
    const base = mkdtempSync(join(tmpdir(), 'install-skills-test-'));
    const result = installSkills(['claude'], base, true);
    const topLevelSkillName = (path: string): string | null => {
      const marker = `${sep}skills${sep}`;
      const index = path.indexOf(marker);
      if (index === -1) return null;
      return path.slice(index + marker.length).split(sep)[0] ?? null;
    };
    const installedSkillDirs = new Set(
      result.copied.map((path) => topLevelSkillName(path)).filter((name): name is string => Boolean(name)),
    );
    expect(installedSkillDirs).toEqual(new Set(['create-task', 'orc-commands', 'spec', 'worker-inspect']));
    expect(result.copied.some((path) => path.includes(`${sep}evals${sep}`))).toBe(false);
    expect(result.copied.some((path) => path.includes(`${sep}plan-to-tasks-workspace${sep}`))).toBe(false);
  });

  it('returns count matching copied array length', () => {
    const base = mkdtempSync(join(tmpdir(), 'install-skills-test-'));
    const result = installSkills(['claude', 'codex'], base, true);
    expect(result.count).toBe(result.copied.length);
  });

  it('skips unsupported gemini install targets with a warning', () => {
    const base = mkdtempSync(join(tmpdir(), 'install-skills-test-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = installSkills(['gemini'], base, true);
    expect(result).toEqual({ copied: [], count: 0 });
    expect(warn).toHaveBeenCalledWith('Skipping skill installation for unsupported provider target(s): gemini.');
  });
});
