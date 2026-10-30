import { applyOperatorMutation, authorizeOperator, type OperatorRequest } from './operatorMutations.ts';
import { ACTIVE_PROJECT, STATE_DIR } from './paths.ts';
import { clientCredential } from './sessionCredentials.ts';
import { resolveControlPrincipal } from './controlPrincipal.ts';
import { routeToCoordinator } from './projectWriteDispatch.ts';

/**
 * Apply a master or operator mutation (task 232). In a registered project the
 * running coordinator applies it. The caller presents its session when it has
 * one — the master's tools and shells their ORC_MASTER_SECRET, any shell inside
 * a worker session its ORC_SESSION_SECRET (and is refused) — and otherwise acts
 * as the operator. With no coordinator answering, the caller applies it
 * directly and says so: the request provably never reached a coordinator, no live
 * coordinator holds the project's pid lock, and the direct path takes the same
 * state lock. A legacy installation always
 * applies it directly.
 */
export async function submitOperatorMutation(
  request: OperatorRequest,
  {
    env = process.env,
    credential = clientCredential(env),
    direct = { trustedMaster: true }, warn = (line: string) => console.error(line),
    project = ACTIVE_PROJECT, stateDir = STATE_DIR,
  }: {
    env?: NodeJS.ProcessEnv;
    credential?: string | null;
    /** How a legacy installation's direct apply proves it may answer an input request. */
    direct?: { sessionId?: string | null; trustedMaster?: boolean };
    warn?: (line: string) => void;
    project?: unknown;
    stateDir?: string;
  } = {},
): Promise<Record<string, unknown>> {
  if (!project) return applyOperatorMutation(stateDir, request, direct);
  return routeToCoordinator(stateDir, request.op, {
    credential, warn,
    remote: (client) => client.operator(request),
    // The direct path applies the coordinator's own rule, so a worker session cannot use it either.
    authorize: () => authorizeOperator(stateDir, resolveControlPrincipal(stateDir, credential, credential === null), request).actorId,
    direct: (actorId) => applyOperatorMutation(stateDir, { ...request, actor_id: actorId }),
  });
}
