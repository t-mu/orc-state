import { describe, expect, it, vi } from 'vitest';
import { isPackLikeCommand, log } from './prepare.ts';

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
});
