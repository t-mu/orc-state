import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('isBinaryAvailable', () => {
  it('returns true when which succeeds', async () => {
    const execFileSync = vi.fn();
    vi.doMock('node:child_process', () => ({ execFileSync }));
    vi.doMock('./prompts.ts', () => ({ isInteractive: vi.fn() }));
    vi.doMock('@inquirer/prompts', () => ({ confirm: vi.fn() }));

    const { isBinaryAvailable } = await import('./binaryCheck.ts');
    expect(isBinaryAvailable('node')).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith('which', ['node'], { stdio: 'ignore' });
  });

  it('returns false when which throws', async () => {
    const execFileSync = vi.fn().mockImplementation(() => {
      throw new Error('not found');
    });
    vi.doMock('node:child_process', () => ({ execFileSync }));
    vi.doMock('./prompts.ts', () => ({ isInteractive: vi.fn() }));
    vi.doMock('@inquirer/prompts', () => ({ confirm: vi.fn() }));

    const { isBinaryAvailable } = await import('./binaryCheck.ts');
    expect(isBinaryAvailable('missing')).toBe(false);
  });
});

describe('probeProviderAuth', () => {
  it('returns ok:true for unknown provider without calling execSync', async () => {
    const execSync = vi.fn();
    const execFileSync = vi.fn();
    vi.doMock('node:child_process', () => ({ execFileSync, execSync }));
    vi.doMock('./prompts.ts', () => ({ isInteractive: vi.fn() }));
    vi.doMock('@inquirer/prompts', () => ({ confirm: vi.fn() }));

    const { probeProviderAuth } = await import('./binaryCheck.ts');
    expect(probeProviderAuth('unknown-provider')).toEqual({ ok: true });
    expect(execSync).not.toHaveBeenCalled();
  });

  it('returns ok:true when execSync succeeds for a known provider', async () => {
    const execSync = vi.fn().mockReturnValue(Buffer.from('1.0.0'));
    const execFileSync = vi.fn();
    vi.doMock('node:child_process', () => ({ execFileSync, execSync }));
    vi.doMock('./prompts.ts', () => ({ isInteractive: vi.fn() }));
    vi.doMock('@inquirer/prompts', () => ({ confirm: vi.fn() }));

    const { probeProviderAuth } = await import('./binaryCheck.ts');
    expect(probeProviderAuth('claude')).toEqual({ ok: true });
    expect(execSync).toHaveBeenCalledWith('claude --version', { stdio: 'pipe', timeout: 2000 });
  });

  it('returns ok:false with actionable message when execSync throws', async () => {
    const execSync = vi.fn().mockImplementation(() => { throw new Error('auth error'); });
    const execFileSync = vi.fn();
    vi.doMock('node:child_process', () => ({ execFileSync, execSync }));
    vi.doMock('./prompts.ts', () => ({ isInteractive: vi.fn() }));
    vi.doMock('@inquirer/prompts', () => ({ confirm: vi.fn() }));

    const { probeProviderAuth } = await import('./binaryCheck.ts');
    const result = probeProviderAuth('claude');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('claude');
    expect(result.message).toContain('not authenticated');
  });

  it('probes each known provider (codex, gemini)', async () => {
    const execSync = vi.fn().mockReturnValue(Buffer.from('1.0.0'));
    const execFileSync = vi.fn();
    vi.doMock('node:child_process', () => ({ execFileSync, execSync }));
    vi.doMock('./prompts.ts', () => ({ isInteractive: vi.fn() }));
    vi.doMock('@inquirer/prompts', () => ({ confirm: vi.fn() }));

    const { probeProviderAuth } = await import('./binaryCheck.ts');
    expect(probeProviderAuth('codex')).toEqual({ ok: true });
    expect(execSync).toHaveBeenCalledWith('codex --version', { stdio: 'pipe', timeout: 2000 });
    expect(probeProviderAuth('gemini')).toEqual({ ok: true });
    expect(execSync).toHaveBeenCalledWith('gemini --version', { stdio: 'pipe', timeout: 2000 });
  });
});

describe('checkAndInstallBinary', () => {
  it('returns true immediately when binary is already present', async () => {
    const execFileSync = vi.fn();
    const isInteractive = vi.fn().mockReturnValue(true);
    const confirm = vi.fn();

    vi.doMock('node:child_process', () => ({ execFileSync }));
    vi.doMock('./prompts.ts', () => ({ isInteractive }));
    vi.doMock('@inquirer/prompts', () => ({ confirm }));

    const { checkAndInstallBinary } = await import('./binaryCheck.ts');
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
    vi.doMock('./prompts.ts', () => ({ isInteractive }));
    vi.doMock('@inquirer/prompts', () => ({ confirm }));

    const { checkAndInstallBinary } = await import('./binaryCheck.ts');
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
    vi.doMock('./prompts.ts', () => ({ isInteractive }));
    vi.doMock('@inquirer/prompts', () => ({ confirm }));

    const { checkAndInstallBinary } = await import('./binaryCheck.ts');
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
    vi.doMock('./prompts.ts', () => ({ isInteractive }));
    vi.doMock('@inquirer/prompts', () => ({ confirm }));

    const { checkAndInstallBinary } = await import('./binaryCheck.ts');
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
    vi.doMock('./prompts.ts', () => ({ isInteractive }));
    vi.doMock('@inquirer/prompts', () => ({ confirm }));

    const { checkAndInstallBinary } = await import('./binaryCheck.ts');
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
    vi.doMock('./prompts.ts', () => ({ isInteractive }));
    vi.doMock('@inquirer/prompts', () => ({ confirm }));

    const { checkAndInstallBinary } = await import('./binaryCheck.ts');
    await expect(checkAndInstallBinary('gemini')).resolves.toBe(false);
  });
});
