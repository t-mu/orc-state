#!/usr/bin/env node
/** Observe a provider terminal or an independent worktree shell. Input needs --write. */
import { randomUUID } from 'node:crypto';
import { boolFlag } from '../lib/args.ts';
import { ControlClient } from '../lib/controlClient.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { cliError } from './shared.ts';

const [kind, runId] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if ((kind !== 'provider' && kind !== 'shell') || !runId) {
  console.error('Usage: orc terminal <provider|shell> <run_id> [--write] [--once]');
  process.exit(1);
}

const client = new ControlClient(STATE_DIR);
const writable = boolFlag('write');
let leaseId: string | null = null;
let raw = false;
let timer: NodeJS.Timeout | null = null;
let renewTimer: NodeJS.Timeout | null = null;
let closing = false;
let pending = Promise.resolve();

try {
  const { terminal } = await client.openTerminal(kind, runId);
  const terminalId = terminal.terminal_id;
  if (writable) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('--write requires a terminal');
    leaseId = (await client.acquireTerminal(terminalId, `cli:${process.pid}:${randomUUID()}`)).lease_id;
  }
  let cursor = 0;
  const first = await client.observeTerminal(terminalId);
  process.stdout.write(first.output || first.screen);
  cursor = first.cursor;
  if (boolFlag('once') || !process.stdout.isTTY) {
    if (leaseId) await client.releaseTerminal(terminalId, leaseId);
    process.exit(0);
  }

  const cleanup = async () => {
    if (closing) return;
    closing = true;
    if (timer) clearInterval(timer);
    if (renewTimer) clearInterval(renewTimer);
    if (raw) process.stdin.setRawMode(false);
    process.stdin.pause();
    try { await pending; if (leaseId) await client.releaseTerminal(terminalId, leaseId); }
    catch (error) { console.error((error as Error).message); }
    process.exit(0);
  };
  const enqueue = (action: () => Promise<void>) => {
    pending = pending.then(action).catch((error: Error) => {
      console.error(error.message);
      void cleanup();
    });
  };
  process.on('SIGINT', () => { void cleanup(); });
  process.on('SIGTERM', () => { void cleanup(); });
  let polling = false;
  timer = setInterval(() => {
    if (polling || closing) return;
    polling = true;
    client.observeTerminal(terminalId, cursor).then((view) => {
      if (view.output) process.stdout.write(view.output);
      cursor = view.cursor;
      if (view.terminal.state === 'offline') void cleanup();
    }).catch((error: Error) => { console.error(error.message); void cleanup(); })
      .finally(() => { polling = false; });
  }, 200);
  if (leaseId) {
    const writerLease = leaseId;
    console.error('\n[writer lease acquired; Ctrl-] detaches]');
    const resize = () => {
      enqueue(() => client.resizeTerminal(terminalId, writerLease,
        process.stdout.columns ?? 80, process.stdout.rows ?? 24));
    };
    resize();
    process.stdout.on('resize', resize);
    renewTimer = setInterval(() => {
      enqueue(() => client.renewTerminal(terminalId, writerLease));
    }, 10_000);
    process.stdin.setRawMode(true);
    raw = true;
    process.stdin.resume();
    process.stdin.on('data', (chunk: Buffer) => {
      const data = chunk.toString('utf8');
      if (data === '\x1d') { void cleanup(); return; }
      enqueue(() => client.inputTerminal(terminalId, writerLease, data));
    });
  } else {
    console.error('\n[read-only; Ctrl-C detaches]');
  }
} catch (error) {
  if (raw) process.stdin.setRawMode(false);
  cliError(error);
}
