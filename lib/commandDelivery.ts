import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { appendSequencedEvent, withEventDb, withEventDbTransaction } from './eventLog.ts';
import type { CommandEventName } from '../types/events.ts';

export type CommandState = 'queued' | 'dispatching' | 'sent' | 'accepted' | 'running'
  | 'completed' | 'failed' | 'cancelled' | 'outcome_unknown';

export interface DurableCommand {
  command_id: string;
  run_id: string;
  session_id: string | null;
  actor_session_id: string | null;
  actor_id: string;
  recipient_id: string;
  idempotency_key: string;
  kind: string;
  payload: string;
  state: CommandState;
  side_effecting: number;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  deadline_at: string | null;
  dispatch_started_at: string | null;
  send_started_at: string | null;
  created_at: string;
  delivered_at: string | null;
  acknowledged_at: string | null;
  terminal_at: string | null;
  last_error: string | null;
}

export interface EnqueueCommand {
  runId: string;
  recipientSessionId: string;
  idempotencyKey: string;
  kind: string;
  payload: unknown;
  sideEffecting?: boolean;
  maxAttempts?: number;
  deadlineAt?: string;
}

/** Supplied by the trusted CLI/MCP boundary, never by a command request. */
export interface CommandPrincipal {
  agentId: string;
  sessionId: string;
}
export type CommandAuthenticator = (credential: string) => CommandPrincipal | null;

type Session = { session_id: string; agent_id: string; run_id: string | null; state: string };
type Run = { run_id: string; task_ref: string; agent_id: string | null; state: string };
const TERMINAL = new Set<CommandState>(['completed', 'failed', 'cancelled']);

function now(): string { return new Date().toISOString(); }
function row(db: Database.Database, commandId: string): DurableCommand {
  const command = db.prepare('SELECT * FROM commands WHERE command_id = ?').get(commandId) as DurableCommand | undefined;
  if (!command) throw new Error('Command not found');
  return command;
}
function run(db: Database.Database, runId: string): Run {
  const value = db.prepare('SELECT run_id, task_ref, agent_id, state FROM runs WHERE run_id = ?').get(runId) as Run | undefined;
  if (!value) throw new Error('Run not found');
  return value;
}
function session(db: Database.Database, sessionId: string): Session {
  const value = db.prepare('SELECT session_id, agent_id, run_id, state FROM sessions WHERE session_id = ?').get(sessionId) as Session | undefined;
  if (!value || value.state !== 'running') throw new Error('Authenticated session is not running');
  return value;
}
function event(stateDir: string, db: Database.Database, command: DurableCommand, name: CommandEventName, reason?: string): void {
  const owner = run(db, command.run_id);
  appendSequencedEvent(stateDir, {
    ts: now(), event: name, actor_type: 'coordinator', actor_id: 'coordinator',
    run_id: command.run_id, task_ref: owner.task_ref, agent_id: command.recipient_id,
    payload: { command_id: command.command_id, state: command.state, attempt_count: command.attempt_count, ...(reason ? { reason } : {}) },
  });
}
function transition(stateDir: string, db: Database.Database, command: DurableCommand, state: CommandState, name: CommandEventName, reason?: string): DurableCommand {
  const timestamp = now();
  db.prepare(`UPDATE commands SET state = ?, last_error = ?, terminal_at = ? WHERE command_id = ?`)
    .run(state, reason ?? null, TERMINAL.has(state) || state === 'outcome_unknown' ? timestamp : null, command.command_id);
  const updated = row(db, command.command_id);
  event(stateDir, db, updated, name, reason);
  return updated;
}

/**
 * The session IDs are capabilities; caller-supplied actor/recipient names are never trusted.
 * `'coordinator'` is the in-process coordinator itself (task 203): it holds no
 * session credential and is never reachable through the control API.
 */
function enqueueCommand(stateDir: string, principal: CommandPrincipal | 'coordinator', input: EnqueueCommand): DurableCommand {
  if (!input.idempotencyKey || !input.kind) throw new Error('Command key and kind are required');
  if (!Number.isInteger(input.maxAttempts ?? 3) || (input.maxAttempts ?? 3) < 1) throw new Error('maxAttempts must be positive');
  if (input.deadlineAt && !Number.isFinite(Date.parse(input.deadlineAt))) throw new Error('Invalid deadline');
  const payload = JSON.stringify(input.payload);
  if (payload === undefined) throw new Error('Payload must be JSON serializable');
  return withEventDbTransaction(stateDir, (db) => {
    const owner = run(db, input.runId);
    if (!['claimed', 'in_progress'].includes(owner.state)) throw new Error('Run is not active');
    let actor: { session_id: string | null; agent_id: string } = { session_id: null, agent_id: 'coordinator' };
    if (principal !== 'coordinator') {
      const actorSession = session(db, principal.sessionId);
      if (actorSession.agent_id !== principal.agentId) throw new Error('Authenticated actor does not match session');
      if (actorSession.agent_id !== 'master' && (actorSession.agent_id !== owner.agent_id || actorSession.run_id !== input.runId)) {
        throw new Error('Actor is not scoped to the run');
      }
      actor = actorSession;
    }
    const recipient = session(db, input.recipientSessionId);
    if (recipient.run_id !== input.runId || recipient.agent_id !== owner.agent_id) throw new Error('Recipient is not scoped to the run');
    const existing = db.prepare('SELECT * FROM commands WHERE run_id = ? AND idempotency_key = ?')
      .get(input.runId, input.idempotencyKey) as DurableCommand | undefined;
    if (existing) {
      if (existing.actor_session_id !== actor.session_id || existing.session_id !== recipient.session_id
        || existing.kind !== input.kind || existing.payload !== payload
        || existing.side_effecting !== (input.sideEffecting === false ? 0 : 1)
        || existing.max_attempts !== (input.maxAttempts ?? 3)
        || existing.deadline_at !== (input.deadlineAt ?? null)) throw new Error('Idempotency key conflicts with existing command');
      return existing;
    }
    const commandId = `cmd-${randomUUID()}`;
    db.prepare(`INSERT INTO commands
      (command_id, run_id, session_id, actor_session_id, actor_id, recipient_id, idempotency_key,
       kind, payload, state, side_effecting, max_attempts, deadline_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
      .run(commandId, input.runId, recipient.session_id, actor.session_id, actor.agent_id, recipient.agent_id,
        input.idempotencyKey, input.kind, payload, input.sideEffecting === false ? 0 : 1,
        input.maxAttempts ?? 3, input.deadlineAt ?? null, now());
    const command = row(db, commandId);
    event(stateDir, db, command, 'command_queued');
    return command;
  });
}

export function getCommand(stateDir: string, commandId: string): DurableCommand {
  return withEventDb(stateDir, (db) => row(db, commandId));
}

/** Reserve one due command. Recovery must run before dispatching. */
export function reserveCommand(stateDir: string, at = now()): DurableCommand | null {
  return withEventDbTransaction(stateDir, (db) => {
    const command = db.prepare(`SELECT * FROM commands WHERE state = 'queued'
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at, rowid LIMIT 1`)
      .get(at) as DurableCommand | undefined;
    if (!command) return null;
    if (command.deadline_at && command.deadline_at <= at) return transition(stateDir, db, command, 'failed', 'command_failed', 'deadline exceeded');
    db.prepare(`UPDATE commands SET state = 'dispatching', attempt_count = attempt_count + 1,
      dispatch_started_at = ?, send_started_at = NULL WHERE command_id = ?`).run(at, command.command_id);
    const updated = row(db, command.command_id);
    event(stateDir, db, updated, 'command_dispatching');
    return updated;
  });
}

export function markSendStarted(stateDir: string, commandId: string): DurableCommand {
  return withEventDbTransaction(stateDir, (db) => {
    const command = row(db, commandId);
    if (command.state !== 'dispatching' || command.send_started_at) throw new Error('Command is not reserved for send');
    if (!['claimed', 'in_progress'].includes(run(db, command.run_id).state)) throw new Error('Run is no longer active');
    const recipient = session(db, command.session_id!);
    if (recipient.run_id !== command.run_id || recipient.agent_id !== command.recipient_id) throw new Error('Recipient session changed');
    db.prepare('UPDATE commands SET send_started_at = ? WHERE command_id = ?').run(now(), commandId);
    const updated = row(db, commandId);
    event(stateDir, db, updated, 'command_send_started');
    return updated;
  });
}

export function markSent(stateDir: string, commandId: string): DurableCommand {
  return withEventDbTransaction(stateDir, (db) => {
    const command = row(db, commandId);
    if (command.state !== 'dispatching' || !command.send_started_at) return command;
    db.prepare(`UPDATE commands SET state = 'sent', delivered_at = ? WHERE command_id = ?`).run(now(), commandId);
    const updated = row(db, commandId);
    event(stateDir, db, updated, 'command_sent');
    return updated;
  });
}

export type AckState = 'accepted' | 'running' | 'completed' | 'failed';
const ACK_ALLOWED: Record<AckState, string[]> = {
  accepted: ['dispatching', 'sent', 'outcome_unknown'],
  running: ['accepted'],
  completed: ['accepted', 'running'],
  failed: ['accepted', 'running'],
};

function applyAck(stateDir: string, db: Database.Database, command: DurableCommand, state: AckState, reason?: string): DurableCommand {
  if (!ACK_ALLOWED[state].includes(command.state) || (command.state === 'dispatching' && !command.send_started_at)) {
    throw new Error(`Cannot acknowledge ${command.state} as ${state}`);
  }
  const stamp = now();
  db.prepare('UPDATE commands SET state = ?, acknowledged_at = coalesce(acknowledged_at, ?), terminal_at = ?, last_error = coalesce(?, last_error) WHERE command_id = ?')
    .run(state, stamp, TERMINAL.has(state) ? stamp : null, reason ?? null, command.command_id);
  const updated = row(db, command.command_id);
  event(stateDir, db, updated, `command_${state}` as CommandEventName, reason);
  return updated;
}

function acknowledgeCommand(stateDir: string, commandId: string, principal: CommandPrincipal, state: AckState): DurableCommand {
  return withEventDbTransaction(stateDir, (db) => {
    const command = row(db, commandId);
    const recipient = session(db, principal.sessionId);
    if (recipient.agent_id !== principal.agentId) throw new Error('Authenticated recipient does not match session');
    if (recipient.session_id !== command.session_id || recipient.run_id !== command.run_id
      || recipient.agent_id !== command.recipient_id) throw new Error('ACK from wrong recipient');
    return applyAck(stateDir, db, command, state);
  });
}

const ACK_RANK: Record<string, number> = { dispatching: 0, sent: 0, outcome_unknown: 0, accepted: 1, running: 2, completed: 3, failed: 3, cancelled: 3 };

/**
 * Apply a state the provider PROTOCOL proved for a command delivered to a
 * structured session (task 203): `turn/start` answered → accepted, turn
 * started → running, turn finished → completed/failed. Only the command's own
 * recipient session can move it. Protocol frames can arrive late, twice or out
 * of order (turn/started before the turn/start answer), so a state at or
 * behind the command's current one is a no-op, and a jump ahead passes
 * through the intermediate states.
 */
export function acknowledgeFromRuntime(stateDir: string, commandId: string, sessionId: string, state: AckState, reason?: string): DurableCommand {
  return withEventDbTransaction(stateDir, (db) => {
    let command = row(db, commandId);
    if (command.session_id !== sessionId) throw new Error('Runtime ACK from wrong session');
    if (command.state === 'queued' || (command.state === 'dispatching' && !command.send_started_at)) {
      throw new Error(`Cannot acknowledge ${command.state} as ${state}`);
    }
    if ((ACK_RANK[command.state] ?? 0) >= ACK_RANK[state]) return command;
    if (command.state !== 'accepted' && command.state !== 'running') command = applyAck(stateDir, db, command, 'accepted');
    if (state === 'accepted') return command;
    if (state === 'running') return command.state === 'running' ? command : applyAck(stateDir, db, command, 'running');
    return applyAck(stateDir, db, command, state, reason);
  });
}

/** A write failure after send-start is uncertain; only explicitly repeatable commands retry. */
export function failTransport(stateDir: string, commandId: string, reason: string): DurableCommand {
  return withEventDbTransaction(stateDir, (db) => {
    const command = row(db, commandId);
    if (command.state !== 'dispatching') return command;
    if (command.send_started_at && command.side_effecting) return transition(stateDir, db, command, 'outcome_unknown', 'command_outcome_unknown', reason);
    if (command.attempt_count >= command.max_attempts) return transition(stateDir, db, command, 'failed', 'command_failed', reason);
    db.prepare(`UPDATE commands SET state = 'queued', next_attempt_at = ?, last_error = ? WHERE command_id = ?`)
      .run(new Date(Date.now() + Math.min(1000 * 2 ** (command.attempt_count - 1), 30000)).toISOString(), reason, commandId);
    const updated = row(db, commandId);
    event(stateDir, db, updated, 'command_queued', reason);
    return updated;
  });
}

/** Recover interrupted reservations and timeouts without replaying uncertain side effects. */
export function reconcileCommands(stateDir: string, at = now(), staleAfterMs = 30000): DurableCommand[] {
  return withEventDbTransaction(stateDir, (db) => {
    const commands = db.prepare(`SELECT * FROM commands WHERE state IN ('queued', 'dispatching', 'sent', 'accepted', 'running')`).all() as DurableCommand[];
    const changed: DurableCommand[] = [];
    for (const command of commands) {
      const recipient = db.prepare('SELECT state FROM sessions WHERE session_id = ?').get(command.session_id) as { state: string } | undefined;
      const activeRun = ['claimed', 'in_progress'].includes(run(db, command.run_id).state);
      const timedOut = Boolean(command.deadline_at && command.deadline_at <= at);
      const stalled = command.state === 'dispatching' && Boolean(command.dispatch_started_at && Date.parse(at) - Date.parse(command.dispatch_started_at) >= staleAfterMs);
      const exited = !recipient || recipient.state !== 'running' || !activeRun;
      if (!timedOut && !stalled && !exited) continue;
      const reason = !activeRun ? 'run ended' : exited ? 'recipient session exited' : timedOut ? 'deadline exceeded' : 'dispatch interrupted';
      if (command.state === 'queued' || (command.state === 'dispatching' && !command.send_started_at)) {
        if (exited || timedOut || command.attempt_count >= command.max_attempts) {
          changed.push(transition(stateDir, db, command, 'failed', 'command_failed', reason));
        } else {
          db.prepare(`UPDATE commands SET state = 'queued', next_attempt_at = ?, last_error = ? WHERE command_id = ?`).run(at, reason, command.command_id);
          const updated = row(db, command.command_id);
          event(stateDir, db, updated, 'command_queued', reason);
          changed.push(updated);
        }
      } else if (command.side_effecting) {
        changed.push(transition(stateDir, db, command, 'outcome_unknown', 'command_outcome_unknown', reason));
      } else if (command.state === 'dispatching' && !exited && !timedOut && command.attempt_count < command.max_attempts) {
        db.prepare(`UPDATE commands SET state = 'queued', next_attempt_at = ?, last_error = ? WHERE command_id = ?`).run(at, reason, command.command_id);
        const updated = row(db, command.command_id);
        event(stateDir, db, updated, 'command_queued', reason);
        changed.push(updated);
      } else {
        changed.push(transition(stateDir, db, command, 'failed', 'command_failed', reason));
      }
    }
    return changed;
  });
}

/** An operator must supply a current master session and an explicit outcome. */
function resolveUnknownCommand(stateDir: string, commandId: string, principal: CommandPrincipal, outcome: 'completed' | 'failed' | 'cancelled', reason: string): DurableCommand {
  if (!reason.trim()) throw new Error('Resolution reason is required');
  return withEventDbTransaction(stateDir, (db) => {
    if (principal.agentId !== 'master' || session(db, principal.sessionId).agent_id !== principal.agentId) throw new Error('Master session required');
    const command = row(db, commandId);
    if (command.state !== 'outcome_unknown') throw new Error('Command outcome is not unknown');
    return transition(stateDir, db, command, outcome, `command_${outcome}` as CommandEventName, reason);
  });
}

export interface CommandTransport {
  send(command: DurableCommand): Promise<void>;
  isAlive?(command: DurableCommand): Promise<boolean>;
}

function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('transport operation timed out')), timeoutMs);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

/** Wake on enqueue and sweep periodically; each tick is safe to rerun after a crash. */
export class CommandDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private readonly stateDir: string;
  private readonly transport: CommandTransport;
  private readonly sweepMs: number;
  private readonly operationTimeoutMs: number;
  private readonly authenticate: CommandAuthenticator;
  constructor(stateDir: string, transport: CommandTransport, authenticate: CommandAuthenticator, sweepMs = 1000, operationTimeoutMs = 30000) {
    if (sweepMs < 1 || operationTimeoutMs < 1) throw new Error('Intervals must be positive');
    this.stateDir = stateDir;
    this.transport = transport;
    this.authenticate = authenticate;
    this.sweepMs = sweepMs;
    this.operationTimeoutMs = operationTimeoutMs;
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      reconcileCommands(this.stateDir);
      void this.tick();
    }, this.sweepMs);
    this.timer.unref();
    this.wake();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  wake(): void { queueMicrotask(() => { void this.tick(); }); }
  private principal(credential: string): CommandPrincipal {
    const principal = this.authenticate(credential);
    if (!principal) throw new Error('Command caller is not authenticated');
    return principal;
  }
  enqueue(credential: string, input: EnqueueCommand): DurableCommand {
    const command = enqueueCommand(this.stateDir, this.principal(credential), input);
    if (this.timer) this.wake();
    return command;
  }
  /** In-process coordinator enqueue; not exposed through the control API. */
  enqueueFromCoordinator(input: EnqueueCommand): DurableCommand {
    const command = enqueueCommand(this.stateDir, 'coordinator', input);
    if (this.timer) this.wake();
    return command;
  }
  /** Dispatch until `commandId` leaves queued/dispatching, or the timeout passes. */
  async deliver(commandId: string, timeoutMs = this.operationTimeoutMs): Promise<DurableCommand> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.tick();
      const command = getCommand(this.stateDir, commandId);
      if ((command.state !== 'queued' && command.state !== 'dispatching') || Date.now() >= deadline) return command;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  acknowledge(credential: string, commandId: string, state: 'accepted' | 'running' | 'completed' | 'failed'): DurableCommand {
    return acknowledgeCommand(this.stateDir, commandId, this.principal(credential), state);
  }
  resolveUnknown(credential: string, commandId: string, outcome: 'completed' | 'failed' | 'cancelled', reason: string): DurableCommand {
    return resolveUnknownCommand(this.stateDir, commandId, this.principal(credential), outcome, reason);
  }
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      reconcileCommands(this.stateDir);
      let command: DurableCommand | null;
      while ((command = reserveCommand(this.stateDir)) !== null) {
        if (command.state !== 'dispatching') continue;
        try {
          if (this.transport.isAlive && !(await bounded(this.transport.isAlive(command), this.operationTimeoutMs))) {
            failTransport(this.stateDir, command.command_id, 'provider exited before send');
            continue;
          }
          markSendStarted(this.stateDir, command.command_id);
          await bounded(this.transport.send(command), this.operationTimeoutMs);
          markSent(this.stateDir, command.command_id);
        } catch (error) {
          failTransport(this.stateDir, command.command_id, (error as Error).message);
        }
      }
    } finally { this.busy = false; }
  }
}
