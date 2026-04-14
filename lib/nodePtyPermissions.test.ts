import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureExecutableBit,
  ensureNodePtySpawnHelperPermissions,
  getNodePtySpawnHelperCandidates,
  resolveInstalledNodePtyLibDir,
} from './nodePtyPermissions.ts';

describe('nodePtyPermissions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the installed node-pty lib directory from an internal entrypoint', () => {
    const resolveModule = vi.fn((specifier: string) => {
      if (specifier === 'node-pty/lib/unixTerminal.js') {
        return '/tmp/node_modules/node-pty/lib/unixTerminal.js';
      }
      throw new Error('unexpected fallback');
    });

    expect(resolveInstalledNodePtyLibDir(resolveModule)).toBe('/tmp/node_modules/node-pty/lib');
  });

  it('returns spawn-helper candidates matching node-pty lookup order', () => {
    expect(getNodePtySpawnHelperCandidates('/pkg/node-pty/lib', 'darwin', 'arm64')).toEqual([
      '/pkg/node-pty/build/Release/spawn-helper',
      '/pkg/node-pty/build/Debug/spawn-helper',
      '/pkg/node-pty/prebuilds/darwin-arm64/spawn-helper',
      '/pkg/node-pty/lib/build/Release/spawn-helper',
      '/pkg/node-pty/lib/build/Debug/spawn-helper',
      '/pkg/node-pty/lib/prebuilds/darwin-arm64/spawn-helper',
    ]);
  });

  it('adds execute bits to a non-executable helper', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orc-node-pty-perms-'));
    const helperPath = join(dir, 'spawn-helper');
    writeFileSync(helperPath, '#!/bin/sh\n');
    chmodSync(helperPath, 0o644);

    expect(ensureExecutableBit(helperPath)).toBe(true);
    expect(statSync(helperPath).mode & 0o111).toBe(0o111);
  });

  it('repairs the first matching spawn-helper path from the installed node-pty layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'orc-node-pty-layout-'));
    const libDir = join(root, 'node_modules', 'node-pty', 'lib');
    const helperDir = join(root, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`);
    const helperPath = join(helperDir, 'spawn-helper');

    mkdirSync(libDir, { recursive: true });
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(helperPath, '#!/bin/sh\n');
    chmodSync(helperPath, 0o644);

    ensureNodePtySpawnHelperPermissions(() => join(libDir, 'unixTerminal.js'));

    expect(statSync(helperPath).mode & 0o111).toBe(0o111);
  });
});
