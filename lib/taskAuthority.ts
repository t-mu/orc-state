import { resolve } from 'node:path';
import { discoverActiveTaskSpecs } from './backlogSync.ts';
import type { Task } from '../types/backlog.ts';

const SPEC_OWNED_UPDATE_FIELDS = ['title', 'description', 'acceptance_criteria', 'depends_on', 'status'] as const;
const SPEC_OWNED_REGISTRATION_FIELDS = ['description', 'acceptance_criteria', 'depends_on'] as const;

function activeBacklogDocsDir(): string {
  if (process.env.ORC_BACKLOG_DIR) return resolve(process.env.ORC_BACKLOG_DIR);
  return resolve('backlog');
}

export function readAuthoritativeTaskSpec(taskRef: string, docsDir: string = activeBacklogDocsDir()) {
  return discoverActiveTaskSpecs(docsDir).find((spec) => spec.ref === taskRef) ?? null;
}

export function assertTaskSpecMatchesRegistration(
  {
    taskRef,
    featureRef,
    title,
  }: {
    taskRef: string;
    featureRef: string;
    title: string;
  },
  docsDir: string = activeBacklogDocsDir(),
) {
  const spec = readAuthoritativeTaskSpec(taskRef, docsDir);
  if (!spec) {
    throw new Error(`Task spec not found in backlog/: ${taskRef}. Create the markdown spec first.`);
  }
  if (spec.feature !== featureRef) {
    throw new Error(`Task feature must match authoritative markdown spec for ${taskRef}: expected ${spec.feature}, got ${featureRef}.`);
  }
  if (spec.title !== title) {
    throw new Error(`Task title must match authoritative markdown spec for ${taskRef}: expected "${spec.title}", got "${title}".`);
  }
  if (spec.status !== 'todo') {
    throw new Error(`Task spec ${taskRef} must be status: todo before registration (got: ${spec.status}).`);
  }
}

export function assertTaskRegistrationFieldsAllowed(
  fields: Partial<Record<(typeof SPEC_OWNED_REGISTRATION_FIELDS)[number], unknown>>,
) {
  const blocked = SPEC_OWNED_REGISTRATION_FIELDS.filter((field) => fields[field] != null);
  if (blocked.length === 0) return;
  throw new Error(`create_task cannot set markdown-authoritative field(s) ${blocked.join(', ')}. Edit backlog markdown instead.`);
}

export function assertTaskUpdateAllowed(
  task: Task,
  updates: Partial<Pick<Task, 'title' | 'description' | 'acceptance_criteria' | 'depends_on' | 'status'>>,
) {
  const blocked = SPEC_OWNED_UPDATE_FIELDS.filter((field) => updates[field] !== undefined);
  if (blocked.length === 0) return;

  if (blocked.length === 1 && blocked[0] === 'status') {
    throw new Error('update_task cannot change status directly. Use lifecycle commands such as task-mark-done, task-reset, task-unblock, delegate_task, or coordinator-owned transitions.');
  }

  const active = task.status === 'claimed' || task.status === 'in_progress';
  const scope = active ? 'while the task is active' : 'through runtime update_task';
  throw new Error(`update_task cannot modify markdown-authoritative field(s) ${blocked.join(', ')} ${scope}. Edit backlog markdown instead.`);
}
