import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmuxAttachCommand, tmuxSessionName, tmuxSocketName, tmuxSocketPath } from './tmux.ts';

const originalBin = process.env.ORC_TMUX_BIN;

const originalTmpdir = process.env.TMUX_TMPDIR;

afterEach(() => {
  if (originalBin == null) delete process.env.ORC_TMUX_BIN; else process.env.ORC_TMUX_BIN = originalBin;
  if (originalTmpdir == null) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = originalTmpdir;
});

describe('tmuxSocketPath', () => {
  it('resolves the socket under TMUX_TMPDIR, falling back to /tmp like tmux', () => {
    const uid = process.getuid?.() ?? 0;
    process.env.TMUX_TMPDIR = '/some/dir';
    expect(tmuxSocketPath('orc-abc')).toBe(join('/some/dir', `tmux-${uid}`, 'orc-abc'));
    delete process.env.TMUX_TMPDIR;
    expect(tmuxSocketPath('orc-abc')).toBe(join('/tmp', `tmux-${uid}`, 'orc-abc'));
    process.env.TMUX_TMPDIR = '';
    expect(tmuxSocketPath('orc-abc')).toBe(join('/tmp', `tmux-${uid}`, 'orc-abc'));
  });
});

describe('tmuxAttachCommand', () => {
  it('attaches read-only to the computed socket and exact session by default', () => {
    delete process.env.ORC_TMUX_BIN;
    expect(tmuxAttachCommand('bob')).toEqual({
      command: 'tmux',
      args: ['-L', tmuxSocketName(), 'attach-session', '-r', '-t', `=${tmuxSessionName('bob')}`],
    });
  });

  it('drops -r under write and prefers the names recorded in provider_ref', () => {
    process.env.ORC_TMUX_BIN = '/opt/tmux';
    expect(tmuxAttachCommand('bob', { write: true, providerRef: { tmux_socket: 'orc-sock', tmux_session: 'orc-bob-1' } })).toEqual({
      command: '/opt/tmux',
      args: ['-L', 'orc-sock', 'attach-session', '-t', '=orc-bob-1'],
    });
  });

  it('ignores provider_ref values that are not names', () => {
    const { args } = tmuxAttachCommand('bob', { providerRef: { tmux_socket: '', tmux_session: 42 } });
    expect(args).toEqual(['-L', tmuxSocketName(), 'attach-session', '-r', '-t', `=${tmuxSessionName('bob')}`]);
  });
});
