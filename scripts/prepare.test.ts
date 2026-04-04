import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { isPackLikeCommand, log } from './prepare.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('scripts/prepare.ts', () => {
  it('treats pack and dry-run publish workflows as pack-like', () => {
    expect(isPackLikeCommand({ npm_command: 'pack' })).toBe(true);
    expect(isPackLikeCommand({ npm_command: 'publish' })).toBe(true);
    expect(isPackLikeCommand({ npm_command: 'install', npm_config_dry_run: 'true' })).toBe(true);
    expect(isPackLikeCommand({ npm_command: 'install', npm_config_dry_run: 'false' })).toBe(false);
  });

  it('logs to the provided stream', () => {
    const write = vi.fn();
    log('hello', { write } as unknown as NodeJS.WritableStream);
    expect(write).toHaveBeenCalledWith('[prepare] hello\n');
  });

  it('keeps npm pack json stdout clean when executed as a script', () => {
    const result = spawnSync(process.execPath, ['scripts/prepare.ts'], {
      cwd: ROOT,
      env: { ...process.env, npm_command: 'pack' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('[prepare] skipping git hook setup during npm pack workflow');
  });
});
