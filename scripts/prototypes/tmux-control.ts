#!/usr/bin/env node
// Prototype: tmux control-mode (`tmux -C`) streaming for the terminal viewer.
// Runs on a private tmux server (own -S socket in a temp dir, -f /dev/null),
// never reads or writes orc state, and prints its findings as JSON.
// Usage: node scripts/prototypes/tmux-control.ts [--tui=claude|vim|top] [--dump]  (--dump: snapshot + redraw stream to stderr)
// Findings are recorded in docs/terminal-streaming.md.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'orc-tmux-control-'));
const socket = join(dir, 'sock');
// Strip orc and outer-tmux variables so nothing started here can reach orc state.
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('ORC_') && k !== 'TMUX' && k !== 'TMUX_PANE'),
);
env.TERM = 'xterm-256color';
const W = 100;
const H = 30;

function tmux(...args: string[]): string {
  return execFileSync('tmux', ['-S', socket, '-f', '/dev/null', ...args], { env, encoding: 'utf8' }).trimEnd();
}
function tryTmux(...args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: tmux(...args) };
  } catch (err) {
    return { ok: false, out: String((err as { stderr?: string }).stderr ?? err).trim() };
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(25);
  }
  return pred();
}
const size = (target: string) => tmux('display', '-p', '-t', target, '#{window_width}x#{window_height}');

/** Decode one `%output` payload: tmux writes bytes < 0x20 and `\` as `\ooo` octal, everything else raw. */
export function decodeOutput(payload: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < payload.length; i++) {
    const c = payload[i];
    if (c === 0x5c && i + 3 < payload.length && /^[0-7]{3}$/.test(payload.toString('latin1', i + 1, i + 4))) {
      out.push(parseInt(payload.toString('latin1', i + 1, i + 4), 8));
      i += 3;
    } else out.push(c);
  }
  return Buffer.from(out);
}

interface OutputEvent { t: number; pane: string; raw: Buffer; data: Buffer }

/** Minimal control client: FIFO %begin/%end replies, %output / %extended-output / %exit capture. */
class ControlClient {
  proc: ChildProcessWithoutNullStreams;
  outputs: OutputEvent[] = [];
  notes: string[] = [];
  exited: string | null = null;
  private buf = Buffer.alloc(0);
  private block: string[] | null = null;
  // The first %begin/%end block answers the attach command itself.
  private pending: Array<(r: { ok: boolean; lines: string[] }) => void> = [() => {}];

  constructor(session: string, flags: string[] = []) {
    this.proc = spawn('tmux', ['-S', socket, '-f', '/dev/null', '-C', 'attach-session', ...flags, '-t', `=${session}`], { env });
    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    let nl: number;
    while ((nl = this.buf.indexOf(0x0a)) >= 0) {
      const line = this.buf.subarray(0, nl);
      this.buf = this.buf.subarray(nl + 1);
      this.onLine(line);
    }
  }

  private onLine(line: Buffer): void {
    const text = line.toString('latin1');
    if (this.block) {
      if (/^%(end|error) /.test(text)) {
        this.pending.shift()?.({ ok: text.startsWith('%end'), lines: this.block });
        this.block = null;
      } else this.block.push(text);
      return;
    }
    if (text.startsWith('%begin ')) { this.block = []; return; }
    // %output %<pane> <payload>   |   %extended-output %<pane> <age> ... : <payload>
    const m = /^%output (%\d+) /.exec(text) ?? /^%extended-output (%\d+) \d+[^:]*: /.exec(text);
    if (m) {
      const raw = line.subarray(m[0].length);
      this.outputs.push({ t: Date.now(), pane: m[1], raw, data: decodeOutput(raw) });
      if (text.startsWith('%extended-output')) this.notes.push(text.slice(0, m[0].length));
      return;
    }
    if (text.startsWith('%exit')) this.exited = text;
    this.notes.push(text);
  }

  command(cmd: string): Promise<{ ok: boolean; lines: string[] }> {
    return new Promise((resolve) => {
      this.pending.push(resolve);
      this.proc.stdin.write(`${cmd}\n`);
    });
  }

  text(since = 0): string {
    return Buffer.concat(this.outputs.slice(since).map((o) => o.data)).toString('utf8');
  }
}

/**
 * Just enough of a VT100 to check a redraw: text, CR/LF/BS, cursor moves (CUP, CUU/CUD/CUF/CUB,
 * CHA, VPA), ED and EL, deferred autowrap and scroll at the bottom. SGR, modes and OSC are ignored;
 * every character counts as one cell. `cx`/`cy` are 0-based.
 */
class Screen {
  rows: string[][];
  cx = 0;
  cy = 0;
  private wrapPending = false;
  readonly w: number;
  readonly h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.rows = Array.from({ length: h }, () => Array<string>(w).fill(' '));
  }
  private lf(): void {
    if (this.cy < this.h - 1) this.cy++;
    else { this.rows.shift(); this.rows.push(Array<string>(this.w).fill(' ')); }
  }
  private clamp(): void {
    this.cx = Math.max(0, Math.min(this.w - 1, this.cx));
    this.cy = Math.max(0, Math.min(this.h - 1, this.cy));
    this.wrapPending = false;
  }
  write(s: string): void {
    const re = /\x1b\[([0-9;?<>=]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOc]|[\x00-\x1f]|[^\x00-\x1f\x1b]/gu;
    for (const m of s.matchAll(re)) {
      const tok = m[0];
      if (m[2] !== undefined) {
        const p = (m[1] ?? '').replace(/^[?<>=]/, '').split(';').map((n) => parseInt(n, 10));
        const n = (i: number, d = 1) => (Number.isNaN(p[i]) || p[i] === 0 ? d : p[i]);
        if (/[?<>=]/.test(m[1] ?? '')) continue; // private modes
        switch (m[2]) {
          case 'H': case 'f': this.cy = n(0) - 1; this.cx = n(1) - 1; this.clamp(); break;
          case 'A': this.cy -= n(0); this.clamp(); break;
          case 'B': this.cy += n(0); this.clamp(); break;
          case 'C': this.cx += n(0); this.clamp(); break;
          case 'D': this.cx -= n(0); this.clamp(); break;
          case 'G': this.cx = n(0) - 1; this.clamp(); break;
          case 'd': this.cy = n(0) - 1; this.clamp(); break;
          case 'J': {
            const mode = Number.isNaN(p[0]) ? 0 : p[0];
            if (mode === 0) { this.rows[this.cy].fill(' ', this.cx); for (let y = this.cy + 1; y < this.h; y++) this.rows[y].fill(' '); }
            if (mode === 1) { this.rows[this.cy].fill(' ', 0, this.cx + 1); for (let y = 0; y < this.cy; y++) this.rows[y].fill(' '); }
            if (mode === 2 || mode === 3) this.rows.forEach((r) => r.fill(' '));
            break;
          }
          case 'K': {
            const mode = Number.isNaN(p[0]) ? 0 : p[0];
            const row = this.rows[this.cy];
            if (mode === 0) row.fill(' ', this.cx);
            if (mode === 1) row.fill(' ', 0, this.cx + 1);
            if (mode === 2) row.fill(' ');
            break;
          }
        }
      } else if (tok === '\r') { this.cx = 0; this.wrapPending = false; }
      else if (tok === '\n') { this.lf(); this.wrapPending = false; }
      else if (tok === '\b') { this.cx = Math.max(0, this.cx - 1); this.wrapPending = false; }
      else if (tok.length && tok >= ' ' && tok[0] !== '\x1b') {
        if (this.wrapPending) { this.cx = 0; this.lf(); this.wrapPending = false; }
        this.rows[this.cy][this.cx] = tok;
        if (this.cx === this.w - 1) this.wrapPending = true;
        else this.cx++;
      }
    }
  }
  lines(): string[] {
    return this.rows.map((r) => r.join('').trimEnd());
  }
}

function pickTui(): string[] {
  const arg = process.argv.find((a) => a.startsWith('--tui='))?.slice(6);
  const has = (bin: string) => tryTmuxless('sh', ['-c', `command -v ${bin}`]);
  const choice = arg ?? (['claude', 'htop', 'vim', 'top'].find(has) ?? 'top');
  return choice === 'vim' ? ['vim', '-u', 'NONE', '-N', '+set nu', '/etc/services'] : [choice];
}
function tryTmuxless(cmd: string, args: string[]): boolean {
  try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; }
}

async function main(): Promise<void> {
  const r: Record<string, unknown> = { tmux_version: execFileSync('tmux', ['-V'], { encoding: 'utf8' }).trim() };
  tmux('new-session', '-d', '-s', 'a1', '-x', String(W), '-y', String(H), 'sh');
  tmux('new-session', '-d', '-s', 'a2', '-x', String(W), '-y', String(H), 'sh');
  tmux('set-option', '-g', 'status', 'off');

  // Q2a: attach with no flags; size before/after, then after refresh-client -C.
  const sizeBefore = size('a1');
  const c = new ControlClient('a1');
  await waitFor(() => tmux('list-clients', '-F', '#{client_control_mode}').includes('1'), 3000);
  const sizeAfterAttach = size('a1');
  await c.command('refresh-client -C 80x24');
  await sleep(150);
  const sizeAfterRefreshDefault = size('a1');
  tmux('resize-window', '-t', 'a1', '-x', String(W), '-y', String(H)); // also sets window-size manual
  const windowSizeOpt = tmux('show-options', '-w', '-v', '-t', 'a1', 'window-size');
  await c.command('refresh-client -C 120x40');
  await sleep(150);
  const sizeAfterRefreshManual = size('a1');
  r.q2_resize = { sizeBefore, sizeAfterAttach, sizeAfterRefreshDefault_latest: sizeAfterRefreshDefault, windowSizeOpt, sizeAfterRefreshManual };

  // Q2b: a second client on a2 with -f ignore-size, window-size left at default.
  const ci = new ControlClient('a2', ['-f', 'ignore-size']);
  await waitFor(() => tmux('list-clients', '-F', '#{session_name} #{client_flags}').includes('a2'), 3000);
  await ci.command('refresh-client -C 70x20');
  await sleep(150);
  r.q2_ignore_size = { clientFlags: tmux('list-clients', '-F', '#{session_name}: #{client_flags}'), sizeA2AfterRefresh: size('a2') };

  // Q1: output isolation. Write a marker in each session; only pane a1 should stream to c.
  const panes = { a1: tmux('display', '-p', '-t', 'a1', '#{pane_id}'), a2: tmux('display', '-p', '-t', 'a2', '#{pane_id}') };
  const t0 = Date.now();
  tmux('send-keys', '-t', 'a1', 'echo MARK_A1', 'Enter');
  tmux('send-keys', '-t', 'a2', 'echo MARK_A2', 'Enter');
  await waitFor(() => c.text().includes('MARK_A1\r\n') && ci.text().includes('MARK_A2\r\n'), 3000);
  await sleep(200);
  r.q1_isolation = {
    panes,
    clientA1_panesSeen: [...new Set(c.outputs.map((o) => o.pane))],
    clientA1_hasA2Marker: c.text().includes('MARK_A2'),
    clientA2_panesSeen: [...new Set(ci.outputs.map((o) => o.pane))],
    firstOutputLatencyMs: (c.outputs.find((o) => o.t >= t0)?.t ?? NaN) - t0,
  };

  // Q5: escaping. Emit control chars, a backslash and UTF-8; compare raw payload vs decoded bytes.
  const q5start = c.outputs.length;
  tmux('send-keys', '-t', 'a1', "clear; printf 'T\\tE\\033[1mB\\\\U\\303\\244\\342\\202\\254Z\\n'", 'Enter');
  await waitFor(() => c.text(q5start).includes('Z\r\n'), 3000);
  const ev = c.outputs.slice(q5start).find((o) => o.data.includes('Z\r\n'));
  r.q5_escaping = ev && {
    raw: ev.raw.toString('latin1').slice(ev.raw.indexOf('T\\011')).replace(/\r|\n/g, ''),
    decodedHex: ev.data.subarray(ev.data.indexOf('T\t'), ev.data.indexOf('Z') + 1).toString('hex'),
    decodedUtf8: JSON.stringify(ev.data.subarray(ev.data.indexOf('T\t'), ev.data.indexOf('Z') + 1).toString('utf8')),
  };

  // Q4: snapshot then stream then resize, with a full-screen TUI in a1.
  const tui = pickTui();
  tmux('respawn-pane', '-k', '-t', 'a1', '-c', dir, ...tui);
  let last = '';
  let stable = 0;
  await waitFor(() => {
    const cur = tmux('capture-pane', '-p', '-t', 'a1');
    stable = cur === last && cur.trim() ? stable + 1 : 0;
    last = cur;
    return stable >= 8; // ~8 polls unchanged: initial render finished
  }, 15000);
  const snapshot = tmux('capture-pane', '-e', '-p', '-t', 'a1');
  const cursor = tmux('display', '-p', '-t', 'a1', '#{cursor_x} #{cursor_y}');
  const streamFrom = c.outputs.length;
  tmux('resize-window', '-t', 'a1', '-x', String(W - 1), '-y', String(H));
  await sleep(600);
  tmux('resize-window', '-t', 'a1', '-x', String(W), '-y', String(H));
  await sleep(1500);
  const final = tmux('capture-pane', '-p', '-t', 'a1').split('\n').map((l) => l.trimEnd());
  const redraw = c.text(streamFrom);
  if (process.argv.includes('--dump')) console.error(JSON.stringify({ snapshot, redraw }, null, 1));
  while (final.length < H) final.push('');
  const mismatches = (s: Screen) => s.lines().filter((l, i) => l !== final[i]).length;
  // The viewer's method: paint the snapshot, place the cursor, then apply the stream.
  const viaSnapshot = new Screen(W, H);
  viaSnapshot.write(snapshot.replace(/\n/g, '\r\n'));
  const [cx, cy] = cursor.split(' ').map(Number);
  viaSnapshot.write(`\x1b[${cy + 1};${cx + 1}H`);
  viaSnapshot.write(redraw);
  // Control: the stream alone on a blank screen (is the snapshot even needed?).
  const streamOnly = new Screen(W, H);
  streamOnly.write(redraw);
  r.q4_snapshot = {
    tui: tui[0],
    snapshotBytes: Buffer.byteLength(snapshot),
    cursor,
    redrawBytes: Buffer.byteLength(redraw),
    // Full clear (ED) or home + per-line erase (EL 2), as Ink does.
    redrawHasClear: /\x1b\[[02]?J|\x1b\[H\x1b\[2K/.test(redraw),
    rowsWrong_snapshotPlusStream: mismatches(viaSnapshot),
    rowsWrong_streamOnly: mismatches(streamOnly),
    rows: H,
  };

  // pause-after (3.2+): output switches to %extended-output with an age field.
  const pa = await c.command('refresh-client -f pause-after=2');
  const paFrom = c.notes.length;
  tmux('send-keys', '-t', 'a2', 'echo x', 'Enter');
  tmux('respawn-pane', '-k', '-t', 'a1', 'sh', '-c', 'echo PAUSE_TEST; sleep 5');
  await waitFor(() => c.text().includes('PAUSE_TEST'), 3000);
  r.pause_after = { accepted: pa.ok, notesSample: c.notes.slice(paFrom, paFrom + 3) };

  // %exit: kill a1 while c is attached.
  tmux('kill-session', '-t', 'a1');
  await waitFor(() => c.exited !== null, 3000);
  r.exit_event = c.exited;

  ci.proc.stdin.end();
  console.log(JSON.stringify(r, null, 2));
}

try {
  await main();
} finally {
  tryTmux('kill-server');
  rmSync(dir, { recursive: true, force: true });
}
