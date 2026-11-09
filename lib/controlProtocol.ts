import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrcEvent } from '../types/events.ts';

/**
 * Local daemon control protocol. HTTP/JSON over a Unix domain socket is the
 * interim transport; the endpoint descriptor names the transport so the
 * host-to-container choice deferred by Task 195 can add another one.
 */
export const CONTROL_PROTOCOL_VERSION = 1;
/**
 * The protocol versions this build speaks, `[min, max]`; the client sends the max
 * (`CONTROL_PROTOCOL_VERSION`) and `/v1/health` reports the coordinator's range.
 */
export const CONTROL_PROTOCOL_VERSIONS: readonly [number, number] = [1, CONTROL_PROTOCOL_VERSION];
export const PROTOCOL_HEADER = 'x-orc-protocol';
export const SESSION_HEADER = 'x-orc-session';
/** A caller without a session acts as the operator by presenting the operator token (tasks 232, 231). */
export const OPERATOR_HEADER = 'x-orc-operator';
export const CONTROL_ENDPOINT_FILE = 'control.json';
export const CONTROL_TOKEN_FILE = 'control.token';
/**
 * The operator's credential (task 231), sent as the operator header's value.
 * Every coordinator start writes a new one; sandboxed Claude sessions are
 * denied reading it.
 */
export const OPERATOR_TOKEN_FILE = 'operator.token';

export interface ControlEndpoint {
  protocol_version: number;
  transport: 'unix';
  path: string;
  pid: number;
  started_at: string;
  /** The coordinator's start fingerprint (`lib/processIdentity.ts`), so a reused PID is not mistaken for it. */
  process_start?: string | null;
}

export type ControlErrorCode =
  | 'unsupported_protocol_version' | 'unauthenticated' | 'forbidden'
  | 'not_found' | 'conflict' | 'bad_request' | 'unavailable' | 'internal'
  /** Retryable: the coordinator is sending to the terminal right now. */
  | 'busy'
  /** Client-side only: the caller's AbortSignal fired; the request was destroyed. */
  | 'aborted'
  /** Client-side only: no answer within the call's timeout; the coordinator may still have applied it, so never retry blindly. */
  | 'timeout';

export interface ControlErrorBody { code: ControlErrorCode; message: string }

export type ControlResponse<T> =
  | { protocol_version: number; ok: true; result: T }
  | { protocol_version: number; ok: false; error: ControlErrorBody };

/**
 * One NDJSON line on `/v1/events/stream`. A null event is a skipped invalid row.
 * `closed` is the last frame when the daemon ends the stream on purpose (shutdown).
 * Clients ignore frame types and fields they do not know.
 */
export type StreamFrame =
  | { type: 'event'; seq: number; event: OrcEvent | null }
  | { type: 'heartbeat'; cursor: number }
  | { type: 'closed'; reason: string };

/**
 * One NDJSON line on `/v1/terminals/<id>/stream`. A viewer gets one `snapshot`
 * (the visible screen with its escapes, `capture-pane -e -p`) before any
 * `output`; `data` is base64 of raw pane bytes (a UTF-8 character may span two
 * frames). `resize` reports the pane's new size: repaint. `exit` is the last frame
 * (`reason: 'backlog'` when the viewer was dropped for reading too slowly); the
 * viewer reopens to see the terminal again. Clients ignore frame types and fields they do not know.
 */
export type TerminalFrame =
  | { type: 'snapshot'; screen: string; cursor_x: number; cursor_y: number; columns: number; rows: number }
  | { type: 'output'; data: string }
  | { type: 'resize'; columns: number; rows: number }
  | { type: 'exit'; reason: string }
  | { type: 'heartbeat' };

/** The current holder of a terminal's writer lease. */
export interface TerminalWriter { owner_id: string; expires_at: string }

/**
 * A non-offline session in `GET /v1/sessions`; `terminal_id` is null when it has
 * no streamable terminal (`app:` sessions), `writer` when nobody holds its input lease.
 */
export interface SessionTerminalView {
  session_id: string;
  agent_id: string;
  run_id: string | null;
  provider: string;
  transport: string | null;
  /** `running`, `recoverable` or `unknown`; offline sessions are not listed. */
  state: string;
  /** Why the session is in that state (null for a healthy running session). */
  state_reason: string | null;
  terminal_id: string | null;
  writer: TerminalWriter | null;
}

export interface SubmitCommandRequest {
  run_id: string;
  recipient_session_id: string;
  idempotency_key: string;
  kind: string;
  payload: unknown;
  side_effecting?: boolean;
  max_attempts?: number;
  deadline_at?: string;
}

export type AckState = 'accepted' | 'running' | 'completed' | 'failed';

export class ControlError extends Error {
  readonly code: ControlErrorCode;
  readonly status: number;
  constructor(code: ControlErrorCode, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Unix socket paths are limited to ~104 bytes; long state dirs fall back to a
 * per-user 0700 directory under tmpdir so another user cannot pre-create the path.
 */
export function defaultSocketPath(stateDir: string): string {
  const preferred = join(stateDir, 'control.sock');
  if (Buffer.byteLength(preferred) <= 100) return preferred;
  const dir = join(tmpdir(), `orc-control-${process.getuid?.() ?? 'user'}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
    throw new Error(`Control socket directory ${dir} must be a private directory owned by the current user`);
  }
  return join(dir, `${createHash('sha256').update(stateDir).digest('hex').slice(0, 16)}.sock`);
}
