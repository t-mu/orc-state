import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Backlog, Task } from '../types/backlog.ts';
import type { AgentsState } from '../types/agents.ts';
import type { ClaimsState } from '../types/claims.ts';
import { logger } from './logger.ts';
import { readAuthoritativeClaims, withAuthoritativeAgentSessions } from './runStore.ts';
import { projectTaskStoreFor, readProjectBacklog } from './projectTasks.ts';

export function readJson(stateDir: string, file: string): unknown {
  if (file === 'claims.json') {
    const authoritative = readAuthoritativeClaims(stateDir);
    if (authoritative) return authoritative;
  }
  if (file === 'backlog.json') {
    const store = projectTaskStoreFor(stateDir);
    if (store) return readProjectBacklog(store);
  }
  return JSON.parse(readFileSync(join(stateDir, file), 'utf8'));
}

export function readBacklog(stateDir: string): Backlog {
  const raw = readJson(stateDir, 'backlog.json') as Record<string, unknown>;
  // Backward compat: JSON written before the epics→features rename.
  if (!raw.features && Array.isArray(raw.epics)) {
    raw.features = raw.epics;
    delete raw.epics;
  }
  return raw as unknown as Backlog;
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
