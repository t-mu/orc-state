import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSocketPath } from './controlProtocol.ts';

describe('defaultSocketPath', () => {
  let root: string;
  let home: string;
  let tmp: string;
  let longStateDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orc-sock-'));
    home = join(root, 'h');
    tmp = join(root, 't');
    longStateDir = join(root, 'state', 'x'.repeat(120));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('keeps a short state dir socket on every platform', () => {
    const stateDir = join(root, 's');
    for (const platform of ['darwin', 'linux'] as const) {
      expect(defaultSocketPath(stateDir, { platform, homeDir: home, tmpDir: tmp })).toBe(join(stateDir, 'control.sock'));
    }
  });

  it('puts a long-state-dir socket in ~/.orc/run on macOS with 0700 permissions', () => {
    const path = defaultSocketPath(longStateDir, { platform: 'darwin', homeDir: home, tmpDir: tmp });
    expect(path.startsWith(join(home, '.orc', 'run') + '/')).toBe(true);
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(104);
    expect(statSync(join(home, '.orc', 'run')).mode & 0o777).toBe(0o700);
    expect(defaultSocketPath(longStateDir, { platform: 'darwin', homeDir: home, tmpDir: tmp })).toBe(path);
  });

  it('falls back to tmpdir on macOS when the home path is too long', () => {
    const longHome = join(root, 'y'.repeat(100));
    const path = defaultSocketPath(longStateDir, { platform: 'darwin', homeDir: longHome, tmpDir: tmp });
    expect(path.startsWith(join(tmp, 'orc-control-'))).toBe(true);
  });

  it('keeps the tmpdir fallback on Linux', () => {
    const path = defaultSocketPath(longStateDir, { platform: 'linux', homeDir: home, tmpDir: tmp });
    expect(path).toMatch(new RegExp(`^${tmp}/orc-control-[^/]+/[0-9a-f]{16}\\.sock$`));
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
  });
});
