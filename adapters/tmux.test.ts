import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkTmux, checkTmuxVersion, createTmuxAdapter, failedInspection, parseDeadPane, parsePaneSignal, parseTmuxVersion, tmuxAttachCommand, tmuxSessionName,
  tmuxSocketName, tmuxSocketPath,
} from './tmux.ts';
import { EXPLORER_SOCKET } from '../lib/cockpit2/explorer.ts';
import { classifySessionExit } from '../lib/sessionResume.ts';

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

describe('orc tmux socket paths stay under the Unix socket limit', () => {
  // sun_path holds 104 bytes on macOS (108 on Linux) including the NUL.
  const LIMIT = 103;
  const uid = process.getuid?.() ?? 0;

  it('fits for any state dir, in tmux\'s default directory as macOS resolves it', () => {
    delete process.env.TMUX_TMPDIR;
    const longStateDir = `/Users/someone/${'very-long-directory-name/'.repeat(10)}.orc-state`;
    for (const stateDir of ['/s', longStateDir]) {
      const name = tmuxSocketName(stateDir);
      expect(Buffer.byteLength(tmuxSocketPath(name))).toBeLessThanOrEqual(LIMIT);
      // tmux resolves /tmp to /private/tmp on macOS before connecting.
      expect(Buffer.byteLength(join('/private/tmp', `tmux-${uid}`, name))).toBeLessThanOrEqual(LIMIT);
    }
  });

  it('fits for the cockpit\'s explorer server', () => {
    delete process.env.TMUX_TMPDIR;
    expect(Buffer.byteLength(join('/private/tmp', `tmux-${uid}`, EXPLORER_SOCKET))).toBeLessThanOrEqual(LIMIT);
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

describe('parseDeadPane', () => {
  it('reads a live pane, an unreaped dead pane, an exit code and a killing signal, with the server pid', () => {
    expect(parseDeadPane('0|||812\n')).toEqual({ dead: false, status: null, serverPid: 812 });
    expect(parseDeadPane('1|||812\n')).toEqual({ dead: true, status: null, serverPid: 812 });
    expect(parseDeadPane('1|0||812\n')).toEqual({ dead: true, status: { code: 0, signal: null }, serverPid: 812 });
    expect(parseDeadPane('1||9|812\n')).toEqual({ dead: true, status: { code: null, signal: 9 }, serverPid: 812 });
    expect(parseDeadPane('1||KILL|\n')).toEqual({ dead: true, status: { code: null, signal: 9 }, serverPid: null });
  });

  it('reads tmux 3.6\'s signal names (kill) as the numbers older tmux prints', () => {
    expect(parseDeadPane('1||kill|812\n')).toEqual({ dead: true, status: { code: null, signal: 9 }, serverPid: 812 });
    expect(parseDeadPane('1||term|812\n')).toEqual({ dead: true, status: { code: null, signal: 15 }, serverPid: 812 });
    // Session resume still sees a crash.
    expect(classifySessionExit(parseDeadPane('1||kill|812\n').status, { workComplete: true })).toBe('crash');
  });
});

describe('parsePaneSignal', () => {
  it('takes a number, or a name with or without SIG in any case, as the signal number', () => {
    for (const text of ['9', 'kill', 'KILL', 'SIGKILL', 'sigkill']) expect(parsePaneSignal(text)).toBe(9);
    expect(parsePaneSignal('hup')).toBe(1);
  });

  it('is null without a signal and keeps a name the platform does not know', () => {
    expect(parsePaneSignal('')).toBeNull();
    expect(parsePaneSignal(undefined)).toBeNull();
    expect(parsePaneSignal('bogus')).toBe('bogus');
  });
});

describe('failedInspection', () => {
  it.each([
    ['no server', 'no server running on /tmp/tmux-1000/orc-abc\n'],
    ['no socket', 'error connecting to /tmp/tmux-1000/orc-abc (No such file or directory)\n'],
    ['stale socket', 'error connecting to /tmp/tmux-1000/orc-abc (Connection refused)\n'],
    ['server exiting', 'server exited unexpectedly\n'],
    ['no session', "can't find session: orc-worker-1234\n"],
  ])('is dead when tmux reports the session gone (%s)', (_label, stderr) => {
    expect(failedInspection({ status: 1, stderr })).toEqual({
      transport: 'tmux', alive: false, writable: false, pid: null, processStart: null, reason: 'tmux session not found',
    });
  });

  it('is indeterminate on a timeout, a spawn error, or an unrecognised tmux error', () => {
    const timeout = Object.assign(new Error('spawnSync tmux ETIMEDOUT'), { code: 'ETIMEDOUT' });
    expect(failedInspection({ error: timeout, status: null, stderr: '' })).toMatchObject({
      alive: false, indeterminate: true, reason: 'tmux probe failed: spawnSync tmux ETIMEDOUT',
    });
    expect(failedInspection({ status: 1, stderr: 'error connecting to /tmp/tmux-1000/orc-abc (Resource temporarily unavailable)\n' }))
      .toMatchObject({ alive: false, indeterminate: true });
    expect(failedInspection({ status: 1, stderr: '' })).toMatchObject({ indeterminate: true, reason: 'tmux probe failed: exit 1' });
  });
});

describe('tmux adapter inspectSession', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function fakeTmux(script: string): void {
    const d = mkdtempSync(join(tmpdir(), 'orc-fake-tmux-'));
    dirs.push(d);
    const bin = join(d, 'tmux');
    writeFileSync(bin, `#!/bin/sh\n${script}\n`);
    chmodSync(bin, 0o755);
    process.env.ORC_TMUX_BIN = bin;
  }

  it('reports a missing tmux binary as indeterminate, not dead', () => {
    process.env.ORC_TMUX_BIN = '/nonexistent/tmux';
    expect(createTmuxAdapter().inspectSession('tmux:worker-1')).toMatchObject({ alive: false, indeterminate: true });
  });

  it('reports a transient tmux error as indeterminate and a missing server as dead', () => {
    fakeTmux("echo 'error connecting to /tmp/x (Resource temporarily unavailable)' >&2; exit 1");
    expect(createTmuxAdapter().inspectSession('tmux:worker-1')).toMatchObject({ alive: false, indeterminate: true });
    fakeTmux("echo 'no server running on /tmp/x' >&2; exit 1");
    const dead = createTmuxAdapter().inspectSession('tmux:worker-1');
    expect(dead).toMatchObject({ alive: false, reason: 'tmux session not found' });
    expect(dead.indeterminate).toBeUndefined();
  });
});

