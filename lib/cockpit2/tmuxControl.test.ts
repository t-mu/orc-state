import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PaneModes } from './screen.ts';
import {
  SEND_CHUNK_BYTES, SERVER_VERSION_COMMAND, TmuxControlClient, pasteNeedsRawFlag, quoteTmuxArgument, type ControlProcess, type PaneReport,
} from './tmuxControl.ts';

class FakeProcess extends EventEmitter implements ControlProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  /** Every line the client wrote, the server-version query included. */
  lines: string[] = [];
  /** The lines after the server-version query every client sends first. */
  get written(): string[] { return this.lines[0] === SERVER_VERSION_COMMAND ? this.lines.slice(1) : this.lines; }
  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => { this.lines.push(...chunk.split('\n').filter(Boolean)); });
  }
  kill(): boolean { this.killed = true; return true; }
  /** tmux writes `lines` to the client's stdout. */
  reply(...lines: string[]): void { this.stdout.write(Buffer.from(lines.map((line) => `${line}\n`).join(''))); }
  /** A reply to a command from stdin (`%begin` flags 1). */
  ok(...body: string[]): void { this.reply('%begin 1 1 1', ...body, '%end 1 1 1'); }
  /** The attach-session's own reply (`%begin` flags 0), then the reply to the server-version query. */
  attached(version = '3.6a'): void { this.reply('%begin 1 0 0', '%end 1 0 0'); this.ok(version); }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeClient(ignoreSize = false) {
  const proc = new FakeProcess();
  const calls: Array<{ binary: string; args: string[] }> = [];
  const client = new TmuxControlClient({
    tmuxBinary: '/opt/tmux', socket: 'sock', session: 'master', ignoreSize,
    spawn: (binary, args) => { calls.push({ binary, args }); return proc; },
  });
  return { proc, client, calls };
}

describe('quoteTmuxArgument', () => {
  it('escapes \\, ", $ and ~, writes control bytes as octal and keeps non-ASCII', () => {
    expect(quoteTmuxArgument('$HOME ~ "q" \\ \x1b[1m a\nb\r\x7f ä€😀'))
      .toBe('"\\$HOME \\~ \\"q\\" \\\\ \\033[1m a\\012b\\015\\177 ä€😀"');
  });
});

describe('TmuxControlClient (fake process)', () => {
  it('attaches with the injected binary, -L socket and ignore-size only when asked', () => {
    expect(fakeClient(false).calls).toEqual([{ binary: '/opt/tmux', args: ['-L', 'sock', '-C', 'attach-session', '-t', '=master'] }]);
    expect(fakeClient(true).calls[0].args).toEqual(['-L', 'sock', '-C', 'attach-session', '-f', 'ignore-size', '-t', '=master']);
  });

  it('holds commands until the attach reply, skips it and resolves commands in FIFO order', async () => {
    const { proc, client } = fakeClient();
    const first = client.command('list-panes');
    const second = client.command('list-windows');
    await tick();
    // tmux may run a command written before the attach first, on no session, so nothing is written yet.
    expect(proc.written).toEqual([]);
    proc.attached();
    proc.ok('pane line 1', 'pane line 2');
    proc.ok('window ä');
    await expect(first).resolves.toEqual(['pane line 1', 'pane line 2']);
    await expect(second).resolves.toEqual(['window ä']);
    expect(proc.written).toEqual(['list-panes', 'list-windows']);
  });

  it('matches replies by %begin flags, whatever order the attach reply, notifications and other blocks arrive in', async () => {
    const { proc, client } = fakeClient();
    const output: string[] = [];
    client.on('output', (_pane, bytes) => output.push(bytes.toString('utf8')));
    const modes = client.paneModes('=busy:');
    const next = client.command('list-panes');
    // Output, notifications and a flags-1 block (not ours: nothing is written yet) before the attach reply.
    proc.reply('%output %0 \\033[H1234', '%session-changed $0 busy');
    proc.ok('%9 1 1 0 0 0 0 0 0 0 0 0 0');
    await tick();
    expect(proc.written).toEqual([]);
    // The attach reply split across chunks, with output in between.
    proc.stdout.write('%begin 7 3 0\n%en');
    proc.stdout.write('d 7 3 0\n%output %0 \\033[H5678\n');
    await tick();
    expect(proc.written).toHaveLength(2);
    proc.ok('3.6a');
    // Another flags-0 block tmux runs for this client must not take the first command's place.
    proc.reply('%begin 8 4 0', 'hook output', '%end 8 4 0', '%layout-change @0 aafd,100x30,0,0,0 aafd,100x30,0,0,0 *');
    proc.reply('%begin 9 5 1', '%0 100 30 0 0 0 0 0 0 0 0 0 1', '%end 9 5 1');
    proc.reply('%begin 9 6 1', '%0', '%end 9 6 1');
    await expect(modes).resolves.toMatchObject({ paneId: '%0', cols: 100, rows: 30, cursorVisible: true });
    await expect(next).resolves.toEqual(['%0']);
    expect(output).toEqual(['\x1b[H1234', '\x1b[H5678']);
  });

  it('rejects a command answered with %error and keeps the next one in order', async () => {
    const { proc, client } = fakeClient();
    const bad = client.command('bogus');
    const good = client.command('list-panes');
    proc.attached();
    proc.reply('%begin 2 2 1', 'parse error: unknown command: bogus', '%error 2 2 1');
    proc.ok('%0');
    await expect(bad).rejects.toThrow('parse error: unknown command: bogus');
    await expect(good).resolves.toEqual(['%0']);
  });

  it('emits exit once, rejects pending commands and refuses new ones', async () => {
    const { proc, client } = fakeClient();
    const exits: string[] = [];
    client.on('exit', (reason) => exits.push(reason));
    const pending = client.command('list-panes');
    proc.attached();
    proc.reply('%exit');
    proc.emit('close');
    await expect(pending).rejects.toThrow('exited: terminal exited');
    await expect(client.command('list-panes')).rejects.toThrow('exited');
    expect(exits).toEqual(['terminal exited']);
  });

  it('rejects pending commands when the process closes without %exit', async () => {
    const { proc, client } = fakeClient();
    const pending = client.command('list-panes');
    proc.emit('close');
    await expect(pending).rejects.toThrow('control client closed');
  });

  it('decodes output, layout changes and session changes as typed events and passes other notifications through', async () => {
    const { proc, client } = fakeClient();
    const output: Array<[string, string]> = [];
    const notes: string[] = [];
    const resizes: Array<[number, number]> = [];
    let sessionsChanged = 0;
    client.on('output', (pane, bytes) => output.push([pane, bytes.toString('utf8')]));
    client.on('notification', (line) => notes.push(line));
    client.on('resize', (cols, rows) => resizes.push([cols, rows]));
    client.on('sessionsChanged', () => sessionsChanged++);
    proc.stdout.write(Buffer.concat([Buffer.from('%output %3 \\033[1mä'), Buffer.from('€\\015\\012\n', 'utf8')]));
    proc.reply('%layout-change @0 aafd,120x40,0,0,0 aafd,120x40,0,0,0 *', '%sessions-changed', '%window-add @2',
      '%layout-change @0 bbfd,80x24,0,0,0 bbfd,80x24,0,0,0 *');
    await tick();
    expect(output).toEqual([['%3', '\x1b[1mä€\r\n']]);
    expect(resizes).toEqual([[120, 40], [80, 24]]);
    expect(sessionsChanged).toBe(1);
    expect(notes).toEqual(['%window-add @2']);
  });

  it('reports the pane modes as a PaneReport, which is the screen model\'s PaneModes', () => {
    expectTypeOf<PaneReport>().toMatchTypeOf<PaneModes>();
  });

  it('sends bytes as hex in bounded chunks, in order', async () => {
    const { proc, client } = fakeClient();
    const bytes = Buffer.alloc(SEND_CHUNK_BYTES * 2 + 3, 0);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const sent = client.sendBytes('%1', bytes);
    proc.attached();
    await tick();
    expect(proc.written).toHaveLength(3);
    for (const line of proc.written) expect(line.length).toBeLessThan(2048);
    const echoed = Buffer.from(proc.written.map((line) => line.replace(/^send-keys -t %1 -H /, '').replaceAll(' ', '')).join(''), 'hex');
    expect(echoed.equals(bytes)).toBe(true);
    proc.ok(); proc.ok(); proc.ok();
    await expect(sent).resolves.toBeUndefined();
    await expect(client.sendBytes('%1', Buffer.alloc(0))).resolves.toBeUndefined();
  });

  it('pastes through a unique buffer that paste-buffer deletes', async () => {
    const { proc, client } = fakeClient();
    const pasted = client.paste('%2', '$HOME ~ "x" \\ \x1b\nä');
    void client.paste('%2', 'again');
    proc.attached();
    await tick();
    const [set, paste, set2] = proc.written;
    const name = /^set-buffer -b (\S+) /.exec(set)![1];
    expect(set).toBe(`set-buffer -b ${name} "\\$HOME \\~ \\"x\\" \\\\ \\033\\012ä"`);
    expect(paste).toBe(`paste-buffer -p -d -b ${name} -t %2`);
    expect(/^set-buffer -b (\S+) /.exec(set2)![1]).not.toBe(name);
    proc.ok(); proc.ok();
    await expect(pasted).resolves.toBeUndefined();
  });

  it('asks the server version first and pastes with -S on tmux 3.7+, whose paste-buffer escapes control bytes', async () => {
    const { proc, client } = fakeClient();
    const early = client.paste('%2', '\x1b');
    proc.attached('3.7');
    await tick();
    expect(proc.lines[0]).toBe(SERVER_VERSION_COMMAND);
    const [, paste] = proc.written;
    expect(paste).toMatch(/^paste-buffer -p -d -S -b \S+ -t %2$/);
    proc.ok(); proc.ok();
    await expect(early).resolves.toBeUndefined();
    // Once the version is known a paste is written at once, ahead of keys sent after it.
    void client.paste('%2', 'x');
    void client.sendBytes('%2', Buffer.from('y'));
    await tick();
    expect(proc.written.slice(2)).toEqual([expect.stringMatching(/^set-buffer /), expect.stringMatching(/^paste-buffer -p -d -S /), 'send-keys -t %2 -H 79']);
  });

  it('reads tmux versions: -S from 3.7 on, next- builds and master included', () => {
    for (const version of ['3.7', '3.7a', '3.8', '4.0', 'next-3.7', 'master']) expect(pasteNeedsRawFlag(version), version).toBe(true);
    for (const version of ['3.2', '3.3a', '3.4', '3.6a', 'next-3.6', '', 'openbsd-7.6']) expect(pasteNeedsRawFlag(version), version).toBe(false);
  });

  it('resolves an empty paste without sending a tmux command', async () => {
    const { proc, client } = fakeClient();
    await expect(client.paste('%2', '')).resolves.toBeUndefined();
    await tick();
    expect(proc.written).toEqual([]);
  });

  it('delivers a reply whose body has %end, %error and %begin lines whole, then keeps FIFO order', async () => {
    const { proc, client } = fakeClient();
    const capture = client.capture('%1');
    const failing = expect(client.command('bogus')).rejects.toThrow('%end 5 2 1\nunknown command');
    const next = client.command('list-panes');
    proc.attached();
    proc.reply('%begin 5 2 1', 'foo', '%end of story', '%error 5 2 0', '%begin 6 3 1', 'bar', '%end 5 2 1');
    proc.reply('%begin 5 3 1', '%end 5 2 1', 'unknown command', '%error 5 3 1');
    proc.reply('%begin 5 4 1', '%0', '%end 5 4 1');
    await expect(capture).resolves.toEqual(['foo', '%end of story', '%error 5 2 0', '%begin 6 3 1', 'bar']);
    await failing;
    await expect(next).resolves.toEqual(['%0']);
  });

  it('builds resize, paneModes, capture (live, saved and with history), pause and resume commands', async () => {
    const { proc, client } = fakeClient();
    const resized = client.resize(120, 40);
    const modes = client.paneModes('%4');
    const captured = client.capture('%4');
    const saved = client.capture('%4', { saved: true });
    const history = client.capture('%4', { history: 1000 });
    const paused = client.pause('%4');
    const resumed = client.resume('%4');
    proc.attached();
    await tick();
    expect(proc.written).toEqual([
      'refresh-client -C 120x40',
      "display-message -p -t %4 '#{pane_id} #{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{alternate_on} "
        + "#{mouse_any_flag} #{mouse_button_flag} #{mouse_standard_flag} #{mouse_sgr_flag} #{mouse_utf8_flag} "
        + "#{keypad_cursor_flag} #{cursor_flag}'",
      'capture-pane -p -e -t %4',
      'capture-pane -a -q -p -e -t %4',
      'capture-pane -p -e -S -1000 -t %4',
      "refresh-client -A '%4:pause'",
      "refresh-client -A '%4:continue'",
    ]);
    proc.ok(); proc.ok('%4 100 30 5 7 1 0 1 0 1 0 1 0'); proc.ok('line 1', '\x1b[1mline 2'); proc.ok('main'); proc.ok('old', 'line 1'); proc.ok(); proc.ok();
    await resized;
    await expect(modes).resolves.toEqual({ paneId: '%4', cols: 100, rows: 30, cursorX: 5, cursorY: 7, alternateOn: true,
      mouseAny: false, mouseButton: true, mouseStandard: false, mouseSgr: true, mouseUtf8: false, keypadCursor: true,
      cursorVisible: false });
    await expect(captured).resolves.toEqual(['line 1', '\x1b[1mline 2']);
    await expect(saved).resolves.toEqual(['main']);
    await expect(history).resolves.toEqual(['old', 'line 1']);
    await paused;
    await resumed;
  });

  it('close ends the client and kills only the client process', async () => {
    const { proc, client } = fakeClient();
    const exits: string[] = [];
    client.on('exit', (reason) => exits.push(reason));
    const pending = client.command('list-panes');
    client.close();
    expect(proc.killed).toBe(true);
    await expect(pending).rejects.toThrow('exited: closed');
    expect(exits).toEqual(['closed']);
  });
});
