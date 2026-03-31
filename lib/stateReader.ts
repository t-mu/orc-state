import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Backlog, Task } from '../types/backlog.ts';
import type { AgentsState } from '../types/agents.ts';
import type { ClaimsState } from '../types/claims.ts';

const TASK_SEQ_RE = /(?:^|\/)task-(\d+)(?:-|$)/;

export function readJson(stateDir: string, file: string): unknown {
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
    return readJson(stateDir, 'agents.json') as AgentsState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[stateReader] unexpected error reading agents.json:', err);
    }
    return { version: '1', agents: [] };
  }
}

export function readClaims(stateDir: string): ClaimsState {
  try {
    return readJson(stateDir, 'claims.json') as ClaimsState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[stateReader] unexpected error reading claims.json:', err);
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

export function getNextTaskSeq(backlog: unknown): number {
  const b = backlog as Backlog | null;
  if (Number.isInteger(b?.next_task_seq) && (b?.next_task_seq ?? 0) >= 1) {
    return b!.next_task_seq!;
  }

  let max = 0;
  for (const feature of (b?.features ?? [])) {
    for (const task of feature?.tasks ?? []) {
      const match = typeof task?.ref === 'string'
        ? task.ref.match(TASK_SEQ_RE)
        : null;
      if (!match) continue;
      const value = Number.parseInt(match[1], 10);
      if (Number.isInteger(value) && value > max) max = value;
    }
  }

  return max > 0 ? max + 1 : 1;
}
