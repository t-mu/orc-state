import { listAgents } from './agentRegistry.ts';
import { ControlError } from './controlProtocol.ts';
import { sessionForCredential } from './sessionCredentials.ts';

/**
 * Identity established by a session secret or the coordinator's operator token.
 * A worker (or reviewer) is always scoped to one run; a scout and the master
 * own none. A worker session without a run authenticates nobody.
 */
export type ControlPrincipal =
  | { kind: 'worker'; agentId: string; runId: string; sessionId: string; live: boolean; running: boolean }
  | { kind: 'scout'; agentId: string; runId: null; sessionId: string; live: boolean; running: boolean }
  | { kind: 'master'; agentId: string; runId: null; sessionId: string; live: boolean; running: boolean }
  | { kind: 'operator'; agentId: null; runId: null; sessionId: null; live: true; running: true };

/** Any principal that is a session, not the operator token. */
export type SessionPrincipal = Exclude<ControlPrincipal, { kind: 'operator' }>;

export function resolveControlPrincipal(stateDir: string, credential: string | null, operator: boolean): ControlPrincipal | null {
  if (credential) {
    const session = sessionForCredential(stateDir, credential);
    if (!session) throw new ControlError('unauthenticated', 'Caller is not authenticated', 401);
    // Registration defaults a missing role to worker; a reviewer works one run like a worker.
    const role = listAgents(stateDir).find((entry) => entry.agent_id === session.agent_id)?.role ?? 'worker';
    const common = { agentId: session.agent_id, sessionId: session.session_id, live: session.state !== 'offline', running: session.state === 'running' };
    if (role === 'master') return { kind: 'master', runId: null, ...common };
    if (role === 'scout') return { kind: 'scout', runId: null, ...common };
    if ((role === 'worker' || role === 'reviewer') && session.run_id) return { kind: 'worker', runId: session.run_id, ...common };
    throw new ControlError('unauthenticated', 'Caller is not authenticated', 401);
  }
  return operator ? { kind: 'operator', agentId: null, runId: null, sessionId: null, live: true, running: true } : null;
}

export function requirePrincipal(principal: ControlPrincipal | null, { allowOffline = false }: { allowOffline?: boolean } = {}): ControlPrincipal {
  if (!principal || (!allowOffline && !principal.live)) throw new ControlError('unauthenticated', 'Caller is not an authenticated running session or operator', 401);
  return principal;
}

export function requireProjectReader(principal: ControlPrincipal | null): Extract<ControlPrincipal, { kind: 'master' | 'operator' }> {
  const caller = requirePrincipal(principal);
  if (caller.kind === 'worker' || caller.kind === 'scout') throw new ControlError('forbidden', 'Only the master or the operator may use this route', 403);
  return caller;
}

export function requireProjectAuthor(stateDir: string, principal: ControlPrincipal | null, actorId?: string): string {
  const caller = requireProjectReader(principal);
  // A master session always acts as itself; a named actor is ignored, as the master's operator tools do.
  if (caller.kind === 'master') return caller.agentId;
  const actor = actorId ?? 'human';
  if (actor !== 'human' && !listAgents(stateDir).some((agent) => agent.agent_id === actor)) {
    throw new ControlError('bad_request', `Actor agent not found: ${actor}`, 400);
  }
  return actor;
}
