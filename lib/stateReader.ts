import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Backlog, Task, Feature } from '../types/backlog.ts';
import type { AgentsState } from '../types/agents.ts';
import type { ClaimsState } from '../types/claims.ts';

const TASK_SEQ_RE = /(?:^|\/)task-(\d+)(?:-|$)/;

export function readJson(stateDir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(stateDir, file), 'utf8'));
}

export function readBacklog(stateDir: string): Backlog {
  return readJson(stateDir, 'backlog.json') as Backlog;
}

export function readAgents(stateDir: string): AgentsState {
  try {
    return readJson(stateDir, 'agents.json') as AgentsState;
  } catch {
    return { version: '1', agents: [] };
  }
}

export function readClaims(stateDir: string): ClaimsState {
  try {
    return readJson(stateDir, 'claims.json') as ClaimsState;
  } catch {
    return { version: '1', claims: [] };
  }
}

export function findTask(backlog: unknown, taskRef: string): Task | null {
  const b = backlog as Backlog | null;
  for (const epic of (b?.epics ?? [])) {
    const task = (epic as Feature).tasks?.find((t: Task) => t.ref === taskRef);
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
  for (const epic of (b?.epics ?? [])) {
    for (const task of (epic as Feature)?.tasks ?? []) {
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
