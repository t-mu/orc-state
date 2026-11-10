import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEND_CHUNK_BYTES, TmuxControlClient, quoteTmuxArgument, type ControlProcess } from './tmuxControl.ts';

class FakeProcess extends EventEmitter implements ControlProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  written: string[] = [];
  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => { this.written.push(...chunk.split('\n').filter(Boolean)); });
  }
  kill(): boolean { this.killed = true; return true; }
  /** tmux writes `lines` to the client's stdout. */
  reply(...lines: string[]): void { this.stdout.write(Buffer.from(lines.map((line) => `${line}\n`).join(''))); }
  ok(...body: string[]): void { this.reply('%begin 1 1 1', ...body, '%end 1 1 1'); }
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

  it('skips the attach reply and resolves commands in FIFO order', async () => {
    const { proc, client } = fakeClient();
    const first = client.command('list-panes');
    const second = client.command('list-windows');
    proc.ok('attach body');
    proc.ok('pane line 1', 'pane line 2');
    proc.ok('window ä');
    await expect(first).resolves.toEqual(['pane line 1', 'pane line 2']);
    await expect(second).resolves.toEqual(['window ä']);
    expect(proc.written).toEqual(['list-panes', 'list-windows']);
  });

  it('rejects a command answered with %error and keeps the next one in order', async () => {
    const { proc, client } = fakeClient();
    const bad = client.command('bogus');
    const good = client.command('list-panes');
    proc.ok();
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
    proc.ok();
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

  it('decodes output and passes other notifications through', async () => {
    const { proc, client } = fakeClient();
    const output: Array<[string, string]> = [];
    const notes: string[] = [];
    client.on('output', (pane, bytes) => output.push([pane, bytes.toString('utf8')]));
    client.on('notification', (line) => notes.push(line));
    proc.stdout.write(Buffer.concat([Buffer.from('%output %3 \\033[1mä'), Buffer.from('€\\015\\012\n', 'utf8')]));
    proc.reply('%layout-change @0 aafd,120x40,0,0,0 aafd,120x40,0,0,0 *', '%sessions-changed', '%window-add @2');
    await tick();
    expect(output).toEqual([['%3', '\x1b[1mä€\r\n']]);
    expect(notes).toEqual(['%layout-change @0 aafd,120x40,0,0,0 aafd,120x40,0,0,0 *', '%sessions-changed', '%window-add @2']);
  });

  it('sends bytes as hex in bounded chunks, in order', async () => {
    const { proc, client } = fakeClient();
    const bytes = Buffer.alloc(SEND_CHUNK_BYTES * 2 + 3, 0);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const sent = client.sendBytes('%1', bytes);
    await tick();
    expect(proc.written).toHaveLength(3);
    for (const line of proc.written) expect(line.length).toBeLessThan(2048);
    const echoed = Buffer.from(proc.written.map((line) => line.replace(/^send-keys -t %1 -H /, '').replaceAll(' ', '')).join(''), 'hex');
    expect(echoed.equals(bytes)).toBe(true);
    proc.ok(); proc.ok(); proc.ok(); proc.ok();
    await expect(sent).resolves.toBeUndefined();
    await expect(client.sendBytes('%1', Buffer.alloc(0))).resolves.toBeUndefined();
  });

  it('pastes through a unique buffer that paste-buffer deletes', async () => {
    const { proc, client } = fakeClient();
    const pasted = client.paste('%2', '$HOME ~ "x" \\ \x1b\nä');
    void client.paste('%2', 'again');
    await tick();
    const [set, paste, set2] = proc.written;
    const name = /^set-buffer -b (\S+) /.exec(set)![1];
    expect(set).toBe(`set-buffer -b ${name} "\\$HOME \\~ \\"x\\" \\\\ \\033\\012ä"`);
    expect(paste).toBe(`paste-buffer -p -d -b ${name} -t %2`);
    expect(/^set-buffer -b (\S+) /.exec(set2)![1]).not.toBe(name);
    proc.ok(); proc.ok(); proc.ok();
    await expect(pasted).resolves.toBeUndefined();
  });

  it('builds resize, paneModes, capture, pause and resume commands', async () => {
    const { proc, client } = fakeClient();
    const resized = client.resize(120, 40);
    const modes = client.paneModes('%4');
    const captured = client.capture('%4');
    const paused = client.pause('%4');
    const resumed = client.resume('%4');
    await tick();
    expect(proc.written).toEqual([
      'refresh-client -C 120x40',
      "display-message -p -t %4 '#{pane_id} #{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{alternate_on} "
        + "#{mouse_any_flag} #{mouse_button_flag} #{mouse_standard_flag} #{mouse_sgr_flag} #{mouse_utf8_flag} "
        + "#{keypad_cursor_flag} #{cursor_flag}'",
      'capture-pane -p -e -t %4',
      "refresh-client -A '%4:pause'",
      "refresh-client -A '%4:continue'",
    ]);
    proc.ok(); proc.ok(); proc.ok('%4 100 30 5 7 1 0 1 0 1 0 1 0'); proc.ok('line 1', '\x1b[1mline 2'); proc.ok(); proc.ok();
    await resized;
    await expect(modes).resolves.toEqual({ paneId: '%4', cols: 100, rows: 30, cursorX: 5, cursorY: 7, alternateOn: true,
      mouseAny: false, mouseButton: true, mouseStandard: false, mouseSgr: true, mouseUtf8: false, keypadCursor: true,
      cursorVisible: false });
    await expect(captured).resolves.toEqual(['line 1', '\x1b[1mline 2']);
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

const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!hasTmux)('TmuxControlClient (private tmux server)', () => {
  const socket = `orc-cockpit2-test-${process.pid}-${Date.now()}`;
  let dir = '';
  const clients: TmuxControlClient[] = [];
  const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
  const windowSize = (session: string) => tmux('display-message', '-p', '-t', `=${session}:`, '#{window_width}x#{window_height}').stdout.trim();
  const connect = (session: string, ignoreSize = false) => {
    const client = new TmuxControlClient({ tmuxBinary: 'tmux', socket, session, ignoreSize });
    clients.push(client);
    return client;
  };
  /** A session running `script` in sh, 100x30. */
  const session = (name: string, script: string) => {
    const result = tmux('new-session', '-d', '-s', name, '-x', '100', '-y', '30', `sh -c '${script}'`);
    expect(result.status, result.stderr).toBe(0);
  };
  async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
    const until = Date.now() + ms;
    while (!check()) {
      if (Date.now() > until) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const fileHas = (path: string, length: number) => () => { try { return readFileSync(path).length >= length; } catch { return false; } };
  /** A raw, no-echo `cat` into `path`, started once the shell's tty is set; `prefix` runs first. */
  const reader = (name: string, path: string, prefix = '') => session(name, `${prefix}stty raw -echo; touch ${path}.ready; cat > ${path}`);

  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'cockpit2-tmux-')); });
  afterAll(() => {
    for (const client of clients) client.close();
    tmux('kill-server');
    rmSync(dir, { recursive: true, force: true });
  });

  it('streams pane output as decoded bytes', async () => {
    session('echo', 'sleep 0.5; printf "hi \\033[1mthere \\303\\244\\n"; sleep 30');
    const client = connect('echo', true);
    const seen: Buffer[] = [];
    client.on('output', (_pane, bytes) => seen.push(bytes));
    await waitFor(() => Buffer.concat(seen).toString('utf8').includes('hi \x1b[1mthere ä\r\n'));
  }, 20_000);

  it('delivers arbitrary bytes to the pane exactly', async () => {
    const out = join(dir, 'bytes');
    reader('bytes', out);
    await waitFor(fileHas(`${out}.ready`, 0));
    const client = connect('bytes');
    const [paneId] = await client.command("display-message -p '#{pane_id}'");
    const seen: Buffer[] = [];
    client.on('output', (pane, bytes) => { if (pane === paneId) seen.push(bytes); });
    const payload = Buffer.concat([Buffer.from('a\x1b[1mb\x01\x7f'), Buffer.from('ä€😀', 'utf8'), Buffer.alloc(SEND_CHUNK_BYTES + 10, 0x61)]);
    await client.sendBytes(paneId, payload);
    await waitFor(fileHas(out, payload.length));
    expect(readFileSync(out).equals(payload)).toBe(true);

  }, 20_000);

  for (const bracketed of [false, true]) {
    it(`pastes byte-exact with newlines as CR${bracketed ? ', wrapped in paste markers for mode 2004' : ''}`, async () => {
      const name = bracketed ? 'paste2004' : 'paste';
      const out = join(dir, name);
      reader(name, out, bracketed ? 'printf "\\033[?2004h"; ' : '');
      await waitFor(fileHas(`${out}.ready`, 0));
      const client = connect(name);
      const [paneId] = await client.command("display-message -p '#{pane_id}'");
      const text = 'echo $HOME ~ "q" \\ \x1b[1m\nä€😀 line\nend';
      const expected = Buffer.from((bracketed ? '\x1b[200~' : '') + text.replaceAll('\n', '\r') + (bracketed ? '\x1b[201~' : ''), 'utf8');
      await client.paste(paneId, text);
      await waitFor(fileHas(out, expected.length));
      expect(readFileSync(out).toString('utf8')).toBe(expected.toString('utf8'));
      expect(tmux('list-buffers').stdout).toBe('');
    }, 20_000);
  }

  it('an owned client resizes its window; an ignore-size client does not', async () => {
    session('owned', 'sleep 30');
    const owned = connect('owned');
    await owned.resize(120, 40);
    expect(windowSize('owned')).toBe('120x40');
    owned.close();

    session('viewer', 'sleep 30');
    const before = windowSize('viewer');
    const viewer = connect('viewer', true);
    await viewer.resize(70, 20);
    expect(before).toMatch(/^\d+x\d+$/);
    expect(windowSize('viewer')).toBe(before);
  }, 20_000);

  it('paneModes reports a mode the app set before the client attached', async () => {
    session('modes', 'printf "\\033[?1000h\\033[?1006h\\033[?1049h"; sleep 30');
    await waitFor(() => tmux('display-message', '-p', '-t', '=modes:', '#{alternate_on}').stdout.trim() === '1');
    const client = connect('modes', true);
    const modes = await client.paneModes('=modes:');
    const [cols, rows] = windowSize('modes').split('x').map(Number);
    expect(modes).toMatchObject({ cols, rows, alternateOn: true, mouseStandard: true, mouseSgr: true, mouseAny: true });
    expect(modes.paneId).toMatch(/^%\d+$/);
  }, 20_000);

  it('emits exit when the session is killed', async () => {
    session('doomed', 'sleep 30');
    const client = connect('doomed', true);
    await client.command('refresh-client');
    const exited = new Promise<string>((resolve) => client.on('exit', resolve));
    tmux('kill-session', '-t', '=doomed');
    await expect(exited).resolves.toBeTypeOf('string');
  }, 20_000);
});
