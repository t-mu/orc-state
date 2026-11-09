/**
 * lib/terminalSnapshot.ts — a run's provider terminal screen as plain text (MCP `terminal_snapshot`).
 * Same capture path as `orc terminal provider <run_id> --once`: open the terminal, take the
 * stream's first `snapshot` frame, close. Read-only: it never takes the input lease or sends keys.
 */
import { ControlError } from './controlProtocol.ts';
import type { ControlClient } from './controlClient.ts';

export const TERMINAL_SNAPSHOT_DEFAULT_LINES = 40;
export const TERMINAL_SNAPSHOT_MAX_LINES = 200;

/** The only control calls a snapshot makes: none of them takes the lease or writes to the terminal. */
export type TerminalReader = Pick<ControlClient, 'sessions' | 'openTerminal' | 'streamTerminal'>;

export interface TerminalSnapshotView {
  run_id: string;
  lines: number;
  screen: string;
}

/** Strips CSI, OSC, charset and other short escapes, plus stray control characters (not tab or newline). */
export function stripTerminalEscapes(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]+[0-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** The last `lines` lines, trailing blank lines (the empty part of the pane) dropped first. */
export function lastLines(text: string, lines: number): string {
  const rows = text.split('\n').map((row) => row.trimEnd());
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows.slice(-lines).join('\n');
}

export function snapshotLineCount(lines: unknown): number {
  if (lines === undefined) return TERMINAL_SNAPSHOT_DEFAULT_LINES;
  if (typeof lines !== 'number' || !Number.isInteger(lines) || lines < 1 || lines > TERMINAL_SNAPSHOT_MAX_LINES) {
    throw new ControlError('bad_request', `lines must be an integer from 1 to ${TERMINAL_SNAPSHOT_MAX_LINES}`, 400);
  }
  return lines;
}

export async function terminalSnapshot(client: TerminalReader, runId: string, lines?: unknown): Promise<TerminalSnapshotView> {
  const count = snapshotLineCount(lines);
  if (typeof runId !== 'string' || !runId) throw new ControlError('bad_request', 'run_id is required', 400);
  const session = (await client.sessions()).sessions.filter((row) => row.run_id === runId && row.state === 'running').at(-1);
  if (!session) throw new ControlError('unavailable', `Run ${runId} has no live session`, 503);
  if (session.transport !== 'tmux') {
    throw new ControlError('conflict', `Run ${runId} has a structured (app:) session, not a tmux terminal`, 409);
  }
  const { terminal } = await client.openTerminal('provider', runId);
  const abort = new AbortController();
  try {
    // No size: a read-only viewer must not resize the pane.
    for await (const frame of client.streamTerminal(terminal.terminal_id, {}, abort.signal)) {
      if (frame.type === 'snapshot') return { run_id: runId, lines: count, screen: lastLines(stripTerminalEscapes(frame.screen), count) };
      if (frame.type === 'exit') break;
    }
  } finally {
    abort.abort();
  }
  throw new ControlError('unavailable', `Terminal for run ${runId} ended before a snapshot`, 503);
}
