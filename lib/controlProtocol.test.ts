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
    // A short root whatever TMPDIR is: these tests measure socket path lengths themselves.
    root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'orc-sock-'));
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

  it('never computes a socket path over 103 bytes, even under a macOS-length tmpdir', () => {
    // As long as macOS's tmpdir(), `/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T` (48 bytes).
    const macTmp = join(root, 'T'.repeat(Math.max(1, 48 - root.length - 1)));
    for (const platform of ['darwin', 'linux'] as const) {
      for (const stateDir of [join(root, 's'), longStateDir, join(macTmp, 'orc-state-xxxxxx', 'x'.repeat(40))]) {
        for (const tmpDir of [tmp, macTmp]) {
          const path = defaultSocketPath(stateDir, { platform, homeDir: home, tmpDir });
          expect(Buffer.byteLength(path), path).toBeLessThanOrEqual(103);
        }
      }
    }
  });

  it('keeps the tmpdir fallback on Linux', () => {
    const path = defaultSocketPath(longStateDir, { platform: 'linux', homeDir: home, tmpDir: tmp });
    expect(path.startsWith(join(tmp, 'orc-control-'))).toBe(true);
    expect(path).toMatch(/\/orc-control-[^/]+\/[0-9a-f]{16}\.sock$/);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
  });
});
