import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Local daemon control protocol. HTTP/JSON over a Unix domain socket is the
 * interim transport; the endpoint descriptor names the transport so the
 * host-to-container choice deferred by Task 195 can add another one.
 */
export const CONTROL_PROTOCOL_VERSION = 1;
export const PROTOCOL_HEADER = 'x-orc-protocol';
export const SESSION_HEADER = 'x-orc-session';
export const CONTROL_ENDPOINT_FILE = 'control.json';
export const CONTROL_TOKEN_FILE = 'control.token';

export interface ControlEndpoint {
  protocol_version: number;
  transport: 'unix';
  path: string;
  pid: number;
  started_at: string;
}

export type ControlErrorCode =
  | 'unsupported_protocol_version' | 'unauthenticated' | 'forbidden'
  | 'not_found' | 'conflict' | 'bad_request' | 'internal';

export interface ControlErrorBody { code: ControlErrorCode; message: string }

export type ControlResponse<T> =
  | { protocol_version: number; ok: true; result: T }
  | { protocol_version: number; ok: false; error: ControlErrorBody };

/** One NDJSON line on `/v1/events/stream`. A null event is a skipped invalid row. */
export type StreamFrame =
  | { type: 'event'; seq: number; event: unknown }
  | { type: 'heartbeat'; cursor: number };

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

/** Unix socket paths are limited to ~104 bytes; long state dirs use tmpdir. */
export function defaultSocketPath(stateDir: string): string {
  const preferred = join(stateDir, 'control.sock');
  if (Buffer.byteLength(preferred) <= 100) return preferred;
  return join(tmpdir(), `orc-control-${createHash('sha256').update(stateDir).digest('hex').slice(0, 16)}.sock`);
}
