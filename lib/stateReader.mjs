import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TASK_SEQ_RE = /(?:^|\/)task-(\d+)(?:-|$)/;

export function readJson(stateDir, file) {
  return JSON.parse(readFileSync(join(stateDir, file), 'utf8'));
}

export function findTask(backlog, taskRef) {
  for (const epic of (backlog?.epics ?? [])) {
    const task = epic.tasks?.find((t) => t.ref === taskRef);
    if (task) return task;
  }
  return null;
}

export function readAgents(stateDir) {
  try {
    return readJson(stateDir, 'agents.json');
  } catch {
    return { version: '1', agents: [] };
  }
}

export function readClaims(stateDir) {
  try {
    return readJson(stateDir, 'claims.json');
  } catch {
    return { claims: [] };
  }
}

export function getNextTaskSeq(backlog) {
  if (Number.isInteger(backlog?.next_task_seq) && backlog.next_task_seq >= 1) {
    return backlog.next_task_seq;
  }

  let max = 0;
  for (const epic of backlog?.epics ?? []) {
    for (const task of epic?.tasks ?? []) {
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
