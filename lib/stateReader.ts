import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Backlog, Task } from '../types/backlog.ts';
import type { AgentsState } from '../types/agents.ts';
import type { ClaimsState } from '../types/claims.ts';
import { logger } from './logger.ts';
import { readAuthoritativeClaims, withAuthoritativeAgentSessions } from './runStore.ts';
import { readProjectBacklog, requireProjectTaskStore } from './projectTasks.ts';

/**
 * A state file's contents. Claims come from the run store and the backlog from
 * the project task store; their JSON files are only projections and are never
 * read back.
 */
export function readJson(stateDir: string, file: string): unknown {
  if (file === 'claims.json') {
    const claims = readAuthoritativeClaims(stateDir);
    if (claims) return claims;
    if (existsSync(join(stateDir, 'claims.json'))) {
      // Only a hand-copied claims.json gets here.
      throw new Error(`${join(stateDir, 'claims.json')} could not be imported into the run store (two active claims for one task); keep one active claim per task and retry`);
    }
    return { version: '1', claims: [] } satisfies ClaimsState;
  }
  if (file === 'backlog.json') return readProjectBacklog(requireProjectTaskStore(stateDir));
  return JSON.parse(readFileSync(join(stateDir, file), 'utf8'));
}

export function readBacklog(stateDir: string): Backlog {
  return readJson(stateDir, 'backlog.json') as Backlog;
}

export function readAgents(stateDir: string): AgentsState {
  try {
    return withAuthoritativeAgentSessions(stateDir, readJson(stateDir, 'agents.json') as AgentsState);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error('[stateReader] unexpected error reading agents.json:', err);
    }
    return { version: '1', agents: [] };
  }
}

export function readClaims(stateDir: string): ClaimsState {
  try {
    return readJson(stateDir, 'claims.json') as ClaimsState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error('[stateReader] unexpected error reading claims.json:', err);
    }
    return { version: '1', claims: [] };
  }
}

export function findTask(backlog: unknown, taskRef: string): Task | null {
  const b = backlog as Backlog | null;
  for (const feature of (b?.features ?? [])) {
    const task = feature.tasks?.find((t: Task) => t.ref === taskRef);
    if (task) return task;
  }
  return null;
}
