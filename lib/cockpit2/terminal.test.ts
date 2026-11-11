import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ENTER_SEQUENCE, RESTORE_SEQUENCE, fdWriter, openTerminal, type ExitHooks } from './terminal.ts';

/** A fake TTY pair, process and synchronous output that records everything. */
function fakeTerminal() {
  const writes: string[] = [];
  const raw: boolean[] = [];
  const input = Object.assign(new EventEmitter(), {
    setRawMode(mode: boolean) { raw.push(mode); },
    paused: true,
    resume() { this.paused = false; },
    pause() { this.paused = true; },
  });
  const output = Object.assign(new EventEmitter(), { columns: 80, rows: 24 });
  const exits: number[] = [];
  const hooks = Object.assign(new EventEmitter(), { exit(code: number) { exits.push(code); } }) as EventEmitter & ExitHooks;
  const reports: string[] = [];
  const terminal = openTerminal({
    input, output, hooks, write: (data) => writes.push(data), report: (text) => reports.push(text),
  });
  return { terminal, writes, raw, input, output, hooks, exits, reports };
}

const ESC = '\x1b';

describe('openTerminal', () => {
  it('enters raw mode, the alternate screen, any-motion SGR mouse and bracketed paste', () => {
    const { writes, raw, input } = fakeTerminal();
    expect(raw).toEqual([true]);
    expect(input.paused).toBe(false);
    expect(writes).toEqual([ENTER_SEQUENCE]);
    for (const mode of ['1049', '1003', '1006', '2004']) expect(ENTER_SEQUENCE).toContain(`${ESC}[?${mode}h`);
  });

  it('restores with one write: modes reset, alternate screen left, cursor shown', () => {
    for (const reset of ['?1003l', '?1002l', '?1000l', '?1006l', '?1005l', '?2004l', '?1l', '?1049l', '?25h', '0m']) {
      expect(RESTORE_SEQUENCE).toContain(`${ESC}[${reset}`);
    }
    // The cursor is shown after the alternate screen is left, so the main screen gets it.
    // Cleared first: a terminal that grew on the alternate screen may otherwise keep its cells on the main one.
    expect(RESTORE_SEQUENCE.endsWith(`${ESC}[H${ESC}[2J${ESC}[?1049l${ESC}[?25h`)).toBe(true);
  });

  it('restores synchronously on quit, once, and leaves raw mode', () => {
    const { terminal, writes, raw, input, hooks } = fakeTerminal();
    terminal.write('frame');
    terminal.restore();
    terminal.restore();
    terminal.write('late frame');
    expect(writes).toEqual([ENTER_SEQUENCE, 'frame', RESTORE_SEQUENCE]);
    expect(raw).toEqual([true, false]);
    expect(input.paused).toBe(true);
    // Its process hooks are gone: a later exit restores nothing again.
    for (const event of ['exit', 'uncaughtException', 'unhandledRejection', 'SIGTERM', 'SIGHUP', 'SIGINT']) {
      expect(hooks.listenerCount(event), event).toBe(0);
    }
  });

  it('delivers input and resize events until restored', () => {
    const { terminal, input, output } = fakeTerminal();
    const chunks: string[] = [];
    let resizes = 0;
    terminal.onInput((chunk) => chunks.push(chunk.toString()));
    const stop = terminal.onResize(() => resizes++);
    input.emit('data', Buffer.from('a'));
    output.emit('resize');
    stop();
    output.emit('resize');
    terminal.restore();
    input.emit('data', Buffer.from('b'));
    expect(chunks).toEqual(['a']);
    expect(resizes).toBe(1);
    expect(terminal.size()).toEqual({ cols: 80, rows: 24 });
  });

  it.each([['SIGTERM', 143], ['SIGHUP', 129], ['SIGINT', 130]])('restores on %s and exits %i', (signal, code) => {
    const { writes, exits, hooks } = fakeTerminal();
    hooks.emit(signal);
    expect(writes.at(-1)).toBe(RESTORE_SEQUENCE);
    expect(exits).toEqual([code]);
  });

  it('restores on an uncaught exception or unhandled rejection before reporting it, and exits 1', () => {
    for (const event of ['uncaughtException', 'unhandledRejection']) {
      const { writes, exits, hooks, reports } = fakeTerminal();
      hooks.emit(event, new Error('boom'));
      expect(writes.at(-1)).toBe(RESTORE_SEQUENCE);
      expect(reports.join('')).toContain('boom');
      expect(exits).toEqual([1]);
    }
  });

  it('restores on process exit', () => {
    const { writes, exits, hooks } = fakeTerminal();
    hooks.emit('exit', 0);
    expect(writes.at(-1)).toBe(RESTORE_SEQUENCE);
    expect(exits).toEqual([]);
  });

  it('still exits when the terminal is gone and the restore cannot be written', () => {
    const exits: number[] = [];
    const hooks = Object.assign(new EventEmitter(), { exit(code: number) { exits.push(code); } }) as EventEmitter & ExitHooks;
    let calls = 0;
    openTerminal({
      input: Object.assign(new EventEmitter(), { setRawMode(mode: boolean) { if (!mode) throw new Error('EIO'); }, resume() {}, pause() {} }) as never,
      output: Object.assign(new EventEmitter(), { columns: 80, rows: 24 }),
      hooks,
      write: () => { if (++calls > 1) throw new Error('EIO'); },
    });
    hooks.emit('SIGHUP');
    expect(exits).toEqual([129]);
  });
});

describe('fdWriter', () => {
  it('writes UTF-8 and retries a partial write and EAGAIN', () => {
    const written: Buffer[] = [];
    let call = 0;
    const write = fdWriter(7, (fd, data) => {
      expect(fd).toBe(7);
      call++;
      if (call === 2) throw Object.assign(new Error('again'), { code: 'EAGAIN' });
      const n = Math.min(2, data.length);
      written.push(Buffer.from(data.subarray(0, n)));
      return n;
    });
    write('a✅');
    expect(Buffer.concat(written).toString('utf8')).toBe('a✅');
  });

  it('throws other write errors', () => {
    const write = fdWriter(7, () => { throw Object.assign(new Error('gone'), { code: 'EIO' }); });
    expect(() => write('x')).toThrow('gone');
  });
});
