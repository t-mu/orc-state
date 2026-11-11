import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEND_CHUNK_BYTES, TmuxControlClient } from './tmuxControl.ts';

const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!hasTmux)('TmuxControlClient (private tmux server)', () => {
  const socket = `orc-cockpit-test-${process.pid}-${Date.now()}`;
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
    // The output starts only once the client is attached, so none of it predates the client.
    const go = join(dir, 'echo.go');
    session('echo', `while [ ! -e ${go} ]; do sleep 0.05; done; printf "hi \\033[1mthere \\303\\244\\n"; sleep 30`);
    const client = connect('echo', true);
    const seen: Buffer[] = [];
    client.on('output', (_pane, bytes) => seen.push(bytes));
    await client.command('refresh-client');
    writeFileSync(go, '');
    await waitFor(() => Buffer.concat(seen).toString('utf8').includes('hi \x1b[1mthere ä\r\n'));
  }, 20_000);

  it('delivers arbitrary bytes to the pane exactly', async () => {
    const out = join(dir, 'bytes');
    reader('bytes', out);
    await waitFor(fileHas(`${out}.ready`, 0));
    const client = connect('bytes');
    const [paneId] = await client.command("display-message -p '#{pane_id}'");
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
    const flags = '#{alternate_on}#{mouse_standard_flag}#{mouse_sgr_flag}#{mouse_any_flag}';
    await waitFor(() => tmux('display-message', '-p', '-t', '=modes:', flags).stdout.trim() === '1111');
    const client = connect('modes', true);
    const modes = await client.paneModes('=modes:');
    const [cols, rows] = windowSize('modes').split('x').map(Number);
    expect(modes).toMatchObject({ cols, rows, alternateOn: true, mouseStandard: true, mouseSgr: true, mouseAny: true });
    expect(modes.paneId).toMatch(/^%\d+$/);
  }, 20_000);

  it('every client\'s first paneModes on a continuously redrawing pane gets its own reply', async () => {
    session('busy', 'while :; do printf "\\033[H%s" "$RANDOM"; done');
    const [cols, rows] = windowSize('busy').split('x').map(Number);
    for (let batch = 0; batch < 3; batch++) {
      const batchClients = Array.from({ length: 20 }, (_, index) => connect('busy', index % 2 === 0));
      const results = await Promise.all(batchClients.map((client) => client.paneModes('=busy:')));
      for (const modes of results) expect(modes).toMatchObject({ paneId: expect.stringMatching(/^%\d+$/), cols, rows });
      for (const client of batchClients) client.close();
    }
  }, 10_000);

  it('emits exit when the session is killed', async () => {
    session('doomed', 'sleep 30');
    const client = connect('doomed', true);
    await client.command('refresh-client');
    const exited = new Promise<string>((resolve) => client.on('exit', resolve));
    tmux('kill-session', '-t', '=doomed');
    await expect(exited).resolves.toBeTypeOf('string');
  }, 20_000);
});
