import { afterEach, describe, expect, it } from 'vitest';
import { tmuxAttachCommand, tmuxSessionName, tmuxSocketName } from './tmux.ts';

const originalBin = process.env.ORC_TMUX_BIN;

afterEach(() => {
  if (originalBin == null) delete process.env.ORC_TMUX_BIN; else process.env.ORC_TMUX_BIN = originalBin;
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
