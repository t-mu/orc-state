import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { checkTmux, checkTmuxVersion, parseTmuxVersion, tmuxAttachCommand, tmuxSessionName, tmuxSocketName, tmuxSocketPath } from './tmux.ts';

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

describe('parseTmuxVersion', () => {
  it.each([
    ['tmux 3.2', [3, 2]],
    ['tmux 3.2a', [3, 2]],
    ['tmux 3.3a', [3, 3]],
    ['tmux 3.1c', [3, 1]],
    ['tmux 2.9', [2, 9]],
    ['tmux next-3.5', [3, 5]],
    ['tmux 3.4\n', [3, 4]],
    ['tmux master', [Infinity, Infinity]],
  ])('parses %j', (output, expected) => {
    expect(parseTmuxVersion(output)).toEqual(expected);
  });

  it.each(['', 'tmux', 'screen 4.09', 'tmux three'])('rejects %j', (output) => {
    expect(parseTmuxVersion(output)).toBeNull();
  });
});

describe('checkTmuxVersion', () => {
  it('accepts tmux 3.2 and newer', () => {
    for (const version of ['tmux 3.2', 'tmux 3.2a', 'tmux 3.3a', 'tmux next-3.5', 'tmux 4.0', 'tmux master']) {
      expect(checkTmuxVersion(version)).toEqual({ ok: true, version, problem: null });
    }
  });

  it('rejects tmux older than 3.2', () => {
    for (const version of ['tmux 3.1c', 'tmux 2.9a', 'tmux next-3.1']) {
      expect(checkTmuxVersion(version)).toEqual({ ok: false, version, problem: `${version} is too old; orc needs tmux >= 3.2` });
    }
  });

  it('reports a missing tmux and an unreadable version', () => {
    expect(checkTmuxVersion(null)).toMatchObject({ ok: false, version: null, problem: expect.stringContaining('tmux is not installed') });
    expect(checkTmuxVersion('tmux weird')).toMatchObject({ ok: false, version: 'tmux weird', problem: expect.stringContaining('cannot read the tmux version') });
  });

  it('checkTmux reports a binary that cannot run as missing', () => {
    process.env.ORC_TMUX_BIN = '/nonexistent/tmux';
    expect(checkTmux()).toMatchObject({ ok: false, version: null });
  });
});
