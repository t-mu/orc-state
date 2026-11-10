/**
 * lib/tmuxNames.ts
 *
 * The names of orc's private tmux server and of each agent's session in it.
 * Import-free apart from node:crypto, so the client entry (`orc-state/client`)
 * can compute a project's tmux targets from its state directory without
 * loading the runtime. adapters/tmux.ts wraps these with the process's STATE_DIR.
 */
import { createHash } from 'node:crypto';

/** One private tmux server per state dir; tmux keeps its sockets in a per-user 0700 directory. */
export function tmuxSocketName(stateDir: string): string {
  return `orc-${createHash('sha256').update(stateDir).digest('hex').slice(0, 12)}`;
}

/** Readable and injective: the hash keeps `a.b` and `a_b` from sharing a session. */
export function tmuxSessionName(agentId: string): string {
  const readable = agentId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  return `orc-${readable}-${createHash('sha256').update(agentId).digest('hex').slice(0, 8)}`;
}

/** The tmux socket and session an agent's session runs in: those recorded in its provider_ref win over the computed ones. */
export function tmuxSessionTarget(stateDir: string, agentId: string, providerRef?: unknown): { socket: string; session: string } {
  const ref = (providerRef ?? {}) as { tmux_socket?: unknown; tmux_session?: unknown };
  return {
    socket: typeof ref.tmux_socket === 'string' && ref.tmux_socket ? ref.tmux_socket : tmuxSocketName(stateDir),
    session: typeof ref.tmux_session === 'string' && ref.tmux_session ? ref.tmux_session : tmuxSessionName(agentId),
  };
}
