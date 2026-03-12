import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('isBinaryAvailable', () => {
  it('returns true when which succeeds', async () => {
    const execFileSync = vi.fn();
    vi.doMock('node:child_process', () => ({ execFileSync }));
    vi.doMock('./prompts.mjs', () => ({ isInteractive: vi.fn() }));
    vi.doMock('@inquirer/prompts', () => ({ confirm: vi.fn() }));

    const { isBinaryAvailable } = await import('./binaryCheck.mjs');
    expect(isBinaryAvailable('node')).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith('which', ['node'], { stdio: 'ignore' });
  });

  it('returns false when which throws', async () => {
    const execFileSync = vi.fn().mockImplementation(() => {
      throw new Error('not found');
    });
    vi.doMock('node:child_process', () => ({ execFileSync }));
    vi.doMock('./prompts.mjs', () => ({ isInteractive: vi.fn() }));
    vi.doMock('@inquirer/prompts', () => ({ confirm: vi.fn() }));

    const { isBinaryAvailable } = await import('./binaryCheck.mjs');
    expect(isBinaryAvailable('missing')).toBe(false);
  });
});

describe('checkAndInstallBinary', () => {
  it('returns true immediately when binary is already present', async () => {
    const execFileSync = vi.fn();
    const isInteractive = vi.fn().mockReturnValue(true);
    const confirm = vi.fn();

    vi.doMock('node:child_process', () => ({ execFileSync }));
    vi.doMock('./prompts.mjs', () => ({ isInteractive }));
    vi.doMock('@inquirer/prompts', () => ({ confirm }));

    const { checkAndInstallBinary } = await import('./binaryCheck.mjs');
    await expect(checkAndInstallBinary('claude')).resolves.toBe(true);
    expect(execFileSync).toHaveBeenCalledWith('which', ['claude'], { stdio: 'ignore' });
    expect(confirm).not.toHaveBeenCalled();
    expect(isInteractive).not.toHaveBeenCalled();
  });

  it('returns false in non-interactive mode when binary is missing', async () => {
    const execFileSync = vi.fn().mockImplementation((cmd) => {
      if (cmd === 'which') throw new Error('not found');
      return '';
    });
    const isInteractive = vi.fn().mockReturnValue(false);
    const confirm = vi.fn();

    vi.doMock('node:child_process', () => ({ execFileSync }));
    vi.doMock('./prompts.mjs', () => ({ isInteractive }));
    vi.doMock('@inquirer/prompts', () => ({ confirm }));

    const { checkAndInstallBinary } = await import('./binaryCheck.mjs');
    await expect(checkAndInstallBinary('codex')).resolves.toBe(false);
    expect(isInteractive).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('returns false in interactive mode when user declines install', async () => {
    const execFileSync = vi.fn().mockImplementation((cmd) => {
      if (cmd === 'which') throw new Error('not found');
      return '';
    });
    const isInteractive = vi.fn().mockReturnValue(true);
    const confirm = vi.fn().mockResolvedValue(false);

    vi.doMock('node:child_process', () => ({ execFileSync }));
    vi.doMock('./prompts.mjs', () => ({ isInteractive }));
    vi.doMock('@inquirer/prompts', () => ({ confirm }));

    const { checkAndInstallBinary } = await import('./binaryCheck.mjs');
    await expect(checkAndInstallBinary('gemini')).resolves.toBe(false);
    expect(confirm).toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('installs and returns true when binary becomes available', async () => {
    const execFileSync = vi.fn().mockImplementation((cmd, args) => {
      if (cmd === 'which' && args[0] === 'claude') {
        const whichCalls = execFileSync.mock.calls.filter(([c]) => c === 'which').length;
        if (whichCalls === 1) throw new Error('not found');
        return '/usr/local/bin/claude\n';
      }
      return '';
    });
    const isInteractive = vi.fn().mockReturnValue(true);
    const confirm = vi.fn().mockResolvedValue(true);

    vi.doMock('node:child_process', () => ({ execFileSync }));
    vi.doMock('./prompts.mjs', () => ({ isInteractive }));
    vi.doMock('@inquirer/prompts', () => ({ confirm }));

    const { checkAndInstallBinary } = await import('./binaryCheck.mjs');
    await expect(checkAndInstallBinary('claude')).resolves.toBe(true);

    expect(execFileSync).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '@anthropic-ai/claude-code'],
      { stdio: 'inherit' },
    );
  });

  it('returns false when install succeeds but binary still missing', async () => {
    const execFileSync = vi.fn().mockImplementation((cmd) => {
      if (cmd === 'which') throw new Error('still missing');
      return '';
    });
    const isInteractive = vi.fn().mockReturnValue(true);
    const confirm = vi.fn().mockResolvedValue(true);

    vi.doMock('node:child_process', () => ({ execFileSync }));
    vi.doMock('./prompts.mjs', () => ({ isInteractive }));
    vi.doMock('@inquirer/prompts', () => ({ confirm }));

    const { checkAndInstallBinary } = await import('./binaryCheck.mjs');
    await expect(checkAndInstallBinary('codex')).resolves.toBe(false);
  });

  it('returns false when npm install throws', async () => {
    const execFileSync = vi.fn().mockImplementation((cmd) => {
      if (cmd === 'which') throw new Error('missing');
      if (cmd === 'npm') throw new Error('install failed');
      return '';
    });
    const isInteractive = vi.fn().mockReturnValue(true);
    const confirm = vi.fn().mockResolvedValue(true);

    vi.doMock('node:child_process', () => ({ execFileSync }));
    vi.doMock('./prompts.mjs', () => ({ isInteractive }));
    vi.doMock('@inquirer/prompts', () => ({ confirm }));

    const { checkAndInstallBinary } = await import('./binaryCheck.mjs');
    await expect(checkAndInstallBinary('gemini')).resolves.toBe(false);
  });
});
