import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { appendSequencedEvent, withEventDb, withEventDbTransaction } from './eventLog.ts';
import { writeSessionRow } from './runStore.ts';
import type { SessionExitStatus } from '../adapters/interface.ts';
import type { SessionResumeMode } from './providers.ts';
import type { SessionExitReason, SupervisedSession } from './sessionSupervisor.ts';

/**
 * Resuming a dead worker session in place (task v1/run-resume). A worker whose
 * provider process crashed is relaunched under the same `session_id`, worktree
 * and provider conversation, with a new secret; anything that is not a
 * resumable crash keeps the old behaviour and requeues the run.
 */

/** Resumes allowed per run (its one session) before the run is requeued. */
export const SESSION_RESUME_BUDGET = 2;

/**
 * Which sessions can be resumed: the Claude CLI (orc picks its `--session-id`
 * and relaunches with `--resume`) and Codex on the `app:` runtime
 * (`thread/resume`). The Codex and Gemini terminal CLIs cannot.
 */
export function providerSupportsResume(provider: string, transport: string | null): boolean {
  // A legacy `pty` session (older orc) is never resumed: its exit was not observed.
  if (provider === 'claude') return transport === 'tmux';
  if (provider === 'codex') return transport === 'app-server';
  return false;
}

/**
 * Why a session's process ended. A signal or a non-zero exit is a crash. A
 * clean exit is `finished` once the worker reported its work complete, and a
 * user `/exit` before that. Without an observed status the cause is unknown.
 */
export function classifySessionExit(status: SessionExitStatus | null, { workComplete }: { workComplete: boolean }): SessionExitReason {
  if (!status) return 'unknown';
  if (status.signal != null) return 'crash';
  if (status.code == null) return 'unknown';
  if (status.code !== 0) return 'crash';
  return workComplete ? 'finished' : 'user_exit';
}

export interface ResumeDecisionInput {
  setting: SessionResumeMode;
  provider: string;
  transport: string | null;
  conversationId: string | null;
  exitReason: SessionExitReason;
  resumeCount: number;
  budget?: number;
  worktreeExists: boolean;
}

export type ResumeDecision =
  | { resume: true }
  | { resume: false; reason: string; budgetExhausted: boolean };

/** The single resume-or-requeue decision for a run whose worker session is gone. */
export function decideSessionResume(input: ResumeDecisionInput): ResumeDecision {
  const requeue = (reason: string, budgetExhausted = false): ResumeDecision => ({ resume: false, reason, budgetExhausted });
  if (input.setting === 'off') return requeue('sessions.resume is off');
  if (!providerSupportsResume(input.provider, input.transport)) {
    return requeue(`${input.provider} sessions on ${input.transport ?? 'an unknown transport'} cannot be resumed`);
  }
  if (!input.conversationId) return requeue('no provider conversation id was recorded');
  if (input.exitReason !== 'crash') return requeue(`session exit was not a crash (${input.exitReason})`);
  if (!input.worktreeExists) return requeue('the run worktree no longer exists');
  const budget = input.budget ?? SESSION_RESUME_BUDGET;
  if (input.resumeCount >= budget) return requeue(`resume budget of ${budget} spent`, true);
  return { resume: true };
}

function hasEventDb(stateDir: string): boolean {
  return existsSync(join(stateDir, 'events.db'));
}

/**
 * The agent's latest session for this run, offline or not: a coordinator
 * restart may already have reconciled a dead session to `offline`.
 */
export function latestRunSession(stateDir: string, agentId: string, runId: string): SupervisedSession | null {
  if (!hasEventDb(stateDir)) return null;
  return withEventDb(stateDir, (db) => {
    const row = db.prepare(`SELECT session_id, run_id, agent_id, provider, state, transport, process_pid, process_start,
      owner_id, owner_expires_at, state_reason, provider_conversation_id, generation, resume_count, exit_reason,
      started_at, updated_at FROM sessions WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1`).get(agentId) as SupervisedSession | undefined;
    return row?.run_id === runId ? row : null;
  });
}

/** Record why the session's process ended; the session is offline until a resume revives it. */
export function recordSessionExit(stateDir: string, sessionId: string, exitReason: SessionExitReason): void {
  if (!hasEventDb(stateDir)) return;
  withEventDbTransaction(stateDir, (db) => {
    const reason = `session process exited (${exitReason})`;
    writeSessionRow(db, stateDir, sessionId, {
      set: { exit_reason: exitReason, state: 'offline', state_reason: reason }, at: new Date().toISOString(), reason,
    });
  });
}

/**
 * Start a resume attempt: in one write the old secret's hash is replaced by
 * the new one (so the old secret is rejected from here on), the generation and
 * resume count increase. A failed attempt still counts against the budget.
 */
export function beginSessionResume(stateDir: string, sessionId: string, credentialHash: string): { generation: number; resume_count: number } | null {
  return withEventDbTransaction(stateDir, (db) => {
    const after = writeSessionRow(db, stateDir, sessionId, {
      set: { credential_hash: credentialHash }, increment: ['generation', 'resume_count'],
      at: new Date().toISOString(), reason: 'resume started',
    });
    if (!after) return null;
    return db.prepare('SELECT generation, resume_count FROM sessions WHERE session_id = ?').get(sessionId) as { generation: number; resume_count: number };
  });
}

function taskRefOf(db: Database.Database, runId: string | null): string | null {
  if (!runId) return null;
  return (db.prepare('SELECT task_ref FROM runs WHERE run_id = ?').get(runId) as { task_ref: string } | undefined)?.task_ref ?? null;
}

function resumePayload(session: SupervisedSession, generation: number, conversationId: string | null) {
  return {
    session_id: session.session_id,
    agent_id: session.agent_id,
    ...(session.run_id ? { run_id: session.run_id } : {}),
    generation,
    ...(conversationId ? { provider_conversation_id: conversationId } : {}),
  };
}

/** The relaunched process is running: record its identity and emit `session_resumed`, atomically. */
export function completeSessionResume(stateDir: string, session: SupervisedSession, launched: {
  generation: number;
  providerRef: unknown;
  transport: string | null;
  processPid: number | null;
  processStart: string | null;
  ownerId: string;
  ownerExpiresAt: string;
  conversationId: string | null;
  reason: string;
}): void {
  withEventDbTransaction(stateDir, (db) => {
    const now = new Date().toISOString();
    writeSessionRow(db, stateDir, session.session_id, {
      set: {
        state: 'running', state_reason: null, exit_reason: null,
        provider_ref: launched.providerRef == null ? null : JSON.stringify(launched.providerRef),
        transport: launched.transport, process_pid: launched.processPid, process_start: launched.processStart,
        owner_id: launched.ownerId, owner_expires_at: launched.ownerExpiresAt,
        ...(launched.conversationId != null ? { provider_conversation_id: launched.conversationId } : {}),
      },
      at: now,
      event: ({ taskRef }) => ({
        ts: now, event: 'session_resumed', actor_type: 'coordinator', actor_id: 'coordinator',
        agent_id: session.agent_id,
        ...(session.run_id ? { run_id: session.run_id } : {}),
        ...(taskRef ? { task_ref: taskRef } : {}),
        payload: { ...resumePayload(session, launched.generation, launched.conversationId ?? session.provider_conversation_id), reason: launched.reason },
      }),
    });
  });
}

/** A resume was not possible (budget spent) or its relaunch failed; the run falls back to a requeue. */
export function recordSessionResumeFailed(stateDir: string, session: SupervisedSession, reason: string, generation = session.generation): void {
  withEventDbTransaction(stateDir, (db) => {
    const taskRef = taskRefOf(db, session.run_id);
    appendSequencedEvent(stateDir, {
      ts: new Date().toISOString(), event: 'session_resume_failed', actor_type: 'coordinator', actor_id: 'coordinator',
      agent_id: session.agent_id,
      ...(session.run_id ? { run_id: session.run_id } : {}),
      ...(taskRef ? { task_ref: taskRef } : {}),
      payload: { ...resumePayload(session, generation, session.provider_conversation_id), reason },
    });
  });
}
