#!/usr/bin/env node
/**
 * Stream a provider terminal (by run, or by agent id: a worker, a scout or the master) or an
 * independent worktree shell. Input needs --write; --takeover takes the lease from its holder.
 * --view-first (a cockpit agent tab) opens read-only and takes the lease only while typing
 * (lib/terminalKeys.ts has its keys).
 */
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { boolFlag } from '../lib/args.ts';
import { ControlClient, controlSocketFromEnv } from '../lib/controlClient.ts';
import { ControlError } from '../lib/controlProtocol.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { MOUSE_RESET, TerminalMouseFilter } from '../lib/terminalMouseFilter.ts';
import { MODE_NOTICE, STOP_KEY, TERMINAL_CLOSED_EXIT, terminalKeyAction, type TerminalMode } from '../lib/terminalKeys.ts';
import { cliError } from './shared.ts';
import { readProjectDescriptor } from '../lib/projectContext.ts';
import { formatProjectIdentity } from '../lib/projectHealth.ts';
import { USAGE } from './usage.ts';

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const byRun = positional[0] === 'provider' || positional[0] === 'shell';
if (byRun ? positional.length !== 2 : positional.length !== 1) {
  console.error(`Usage: ${USAGE['terminal']}`);
  process.exit(1);
}

/** Input the coordinator is sending over gets `busy`; it is retried this many times. */
const BUSY_RETRIES = 50;
const BUSY_RETRY_MS = 100;

const client = new ControlClient(STATE_DIR, { socketPath: controlSocketFromEnv() });
// Identity on stderr: stdout carries the raw terminal stream.
console.error(formatProjectIdentity(readProjectDescriptor(STATE_DIR)));
const writable = boolFlag('write');
const viewFirst = boolFlag('view-first');
const once = boolFlag('once') || !process.stdout.isTTY;
const abort = new AbortController();
let leaseId: string | null = null;
let raw = false;
let renewTimer: NodeJS.Timeout | null = null;
let closing = false;
let pending = Promise.resolve();
let terminalId = '';
let inputStarted = false;

const cleanup = async (code = 0) => {
  if (closing) return;
  closing = true;
  abort.abort();
  if (renewTimer) clearInterval(renewTimer);
  // A hung-up terminal (its cockpit tab closed) cannot leave raw mode; the lease is released all the same.
  try { if (raw) process.stdin.setRawMode(false); } catch { /* terminal gone */ }
  process.stdin.pause();
  try { await pending; if (leaseId) await client.releaseTerminal(terminalId, leaseId); }
  catch (error) { console.error((error as Error).message); }
  process.exit(code);
};

const enqueue = (action: () => Promise<void>) => {
  pending = pending.then(action).catch((error: Error) => {
    console.error(error.message);
    void cleanup(1);
  });
};

async function sendInput(lease: string, data: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { return await client.inputTerminal(terminalId, lease, data); }
    catch (error) {
      if (!(error instanceof ControlError) || error.code !== 'busy' || attempt >= BUSY_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
    }
  }
}

try {
  terminalId = (byRun
    ? await client.openTerminal(positional[0] as 'provider' | 'shell', positional[1])
    : await client.openAgentTerminal(positional[0])).terminal.terminal_id;
  if (writable && viewFirst) throw new Error('Use --write or --view-first, not both');
  if (viewFirst && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('--view-first requires a terminal');
  if (writable) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('--write requires a terminal');
    leaseId = (await client.acquireTerminal(terminalId, `cli:${process.pid}:${randomUUID()}`, { takeover: boolFlag('takeover') })).lease_id;
  }
  const size = once ? {} : { columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 };
  const frames = client.streamTerminal(terminalId, { ...(leaseId ? { leaseId } : {}), ...size }, abort.signal);
  process.on('SIGINT', () => { void cleanup(); });
  process.on('SIGTERM', () => { void cleanup(); });
  // Closing the window or tab that runs this releases the lease at once, so reopening it can write.
  process.on('SIGHUP', () => {
    // Writes to the gone terminal fail (EIO); they must not crash the process before the release.
    for (const stream of [process.stdout, process.stderr]) stream.on('error', () => undefined);
    void cleanup();
  });
  // The agent's mouse tracking stays out of this terminal: a hovered tab would type mouse reports into it.
  const decoder = new StringDecoder('utf8');
  const mouseFilter = new TerminalMouseFilter();
  for await (const frame of frames) {
    if (frame.type === 'snapshot') {
      if (once) { process.stdout.write(frame.screen); break; }
      // Reset mouse reporting, clear, draw the captured screen, then put the cursor where the pane has it.
      process.stdout.write(`${MOUSE_RESET}\x1b[H\x1b[2J${frame.screen.replace(/\n$/, '').replace(/\n/g, '\r\n')}\x1b[${frame.cursor_y + 1};${frame.cursor_x + 1}H`);
      if (inputStarted) continue;
      inputStarted = true;
      if (leaseId) startWriter(leaseId);
      else if (viewFirst) startViewer();
      else console.error('\r\n[read-only; Ctrl-C detaches]');
    } else if (frame.type === 'output') {
      process.stdout.write(mouseFilter.filter(decoder.write(Buffer.from(frame.data, 'base64'))));
    } else if (frame.type === 'exit') {
      console.error(`\r\n[terminal stream ended: ${frame.reason}]`);
      break;
    }
  }
  await cleanup();
} catch (error) {
  if (raw) process.stdin.setRawMode(false);
  if (leaseId) await client.releaseTerminal(terminalId, leaseId).catch(() => undefined);
  cliError(error);
}

function startWriter(writerLease: string): void {
  console.error('\r\n[writer lease acquired; Ctrl-] detaches]');
  process.stdout.on('resize', () => {
    enqueue(() => client.resizeTerminal(terminalId, writerLease, process.stdout.columns ?? 80, process.stdout.rows ?? 24));
  });
  renewTimer = setInterval(() => {
    enqueue(() => client.renewTerminal(terminalId, writerLease));
  }, 10_000);
  process.stdin.setRawMode(true);
  raw = true;
  process.stdin.resume();
  process.stdin.on('data', (chunk: Buffer) => {
    const data = chunk.toString('utf8');
    if (data === STOP_KEY) { void cleanup(); return; }
    enqueue(() => sendInput(writerLease, data));
  });
}

/**
 * View-first input: no lease and no key reaches the agent until `i`; the close
 * keys end this process with TERMINAL_CLOSED_EXIT. Typing holds the lease;
 * Ctrl-] releases it and returns to view mode. A lost lease returns to view mode too.
 */
function startViewer(): void {
  let mode: TerminalMode = 'view';
  const notice = (text: string) => console.error(`\r\n${text}`);
  const showMode = () => notice(MODE_NOTICE[mode]);
  const toView = async (message?: string) => {
    mode = 'view';
    if (renewTimer) clearInterval(renewTimer);
    renewTimer = null;
    const lease = leaseId;
    leaseId = null;
    if (message) notice(`[${message}]`);
    showMode();
    if (lease) await client.releaseTerminal(terminalId, lease).catch(() => undefined);
  };
  /** Runs a lease action; a failure (the lease was taken over or expired) returns to view mode. */
  const withLease = (action: (lease: string) => Promise<void>) => {
    pending = pending.then(async () => {
      const lease = leaseId;
      if (!lease || closing) return;
      try { await action(lease); }
      catch (error) { if (leaseId === lease) await toView(`input stopped: ${(error as Error).message}`); }
    });
  };
  const startTyping = () => {
    pending = pending.then(async () => {
      if (leaseId || closing) return;
      try {
        leaseId = (await client.acquireTerminal(terminalId, `cli:${process.pid}:${randomUUID()}`)).lease_id;
      } catch (error) {
        notice(`[cannot type: ${(error as Error).message}]`);
        return;
      }
      mode = 'typing';
      showMode();
      const lease = leaseId;
      renewTimer = setInterval(() => { withLease((current) => client.renewTerminal(terminalId, current)); }, 10_000);
      await client.resizeTerminal(terminalId, lease, process.stdout.columns ?? 80, process.stdout.rows ?? 24).catch(() => undefined);
    });
  };
  process.stdout.on('resize', () => {
    withLease((lease) => client.resizeTerminal(terminalId, lease, process.stdout.columns ?? 80, process.stdout.rows ?? 24));
  });
  showMode();
  process.stdin.setRawMode(true);
  raw = true;
  process.stdin.resume();
  process.stdin.on('data', (chunk: Buffer) => {
    const action = terminalKeyAction(mode, chunk.toString('utf8'));
    if (action.type === 'close') void cleanup(TERMINAL_CLOSED_EXIT);
    else if (action.type === 'start-typing') startTyping();
    else if (action.type === 'stop-typing') {
      // View mode at once: keys typed while the release is pending stay here.
      mode = 'view';
      pending = pending.then(() => toView());
    } else if (action.type === 'send') withLease((lease) => sendInput(lease, action.data));
  });
}
