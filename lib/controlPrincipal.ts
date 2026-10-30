import { listAgents } from './agentRegistry.ts';
import { ControlError } from './controlProtocol.ts';
import { sessionForCredential } from './sessionCredentials.ts';

/** Identity established by a session secret or the coordinator's operator token. */
export type ControlPrincipal =
  | { kind: 'worker'; agentId: string; runId: string; sessionId: string; live: boolean; running: boolean }
  | { kind: 'master'; agentId: string; runId: null; sessionId: string; live: boolean; running: boolean }
  | { kind: 'operator'; agentId: null; runId: null; sessionId: null; live: true };

export function resolveControlPrincipal(stateDir: string, credential: string | null, operator: boolean): ControlPrincipal | null {
  if (credential) {
    const session = sessionForCredential(stateDir, credential);
    if (!session) throw new ControlError('unauthenticated', 'Caller is not authenticated', 401);
    const role = listAgents(stateDir).find((agent) => agent.agent_id === session.agent_id)?.role;
    if (role === 'master') {
      return { kind: 'master', agentId: session.agent_id, runId: null, sessionId: session.session_id,
        live: session.state !== 'offline', running: session.state === 'running' };
    }
    return { kind: 'worker', agentId: session.agent_id, runId: session.run_id ?? '', sessionId: session.session_id,
      live: session.state !== 'offline', running: session.state === 'running' };
  }
  return operator ? { kind: 'operator', agentId: null, runId: null, sessionId: null, live: true } : null;
}

export function requirePrincipal(principal: ControlPrincipal | null, { allowOffline = false }: { allowOffline?: boolean } = {}): ControlPrincipal {
  if (!principal || (!allowOffline && !principal.live)) throw new ControlError('unauthenticated', 'Caller is not an authenticated running session or operator', 401);
  return principal;
}

export function requireProjectReader(principal: ControlPrincipal | null): Extract<ControlPrincipal, { kind: 'master' | 'operator' }> {
  const caller = requirePrincipal(principal);
  if (caller.kind === 'worker') throw new ControlError('forbidden', 'Only the master or the operator may use this route', 403);
  return caller;
}

export function requireProjectAuthor(stateDir: string, principal: ControlPrincipal | null, actorId?: string): string {
  const caller = requireProjectReader(principal);
  if (caller.kind === 'master') {
    if (actorId !== undefined && actorId !== caller.agentId) throw new ControlError('forbidden', `A master session acts as ${caller.agentId}, not ${actorId}`, 403);
    return caller.agentId;
  }
  const actor = actorId ?? 'human';
  if (actor !== 'human' && !listAgents(stateDir).some((agent) => agent.agent_id === actor)) {
    throw new ControlError('bad_request', `Actor agent not found: ${actor}`, 400);
  }
  return actor;
}
