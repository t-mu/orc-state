import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents } from './eventLog.ts';
import { createOrchestratorAjv } from './ajvFactory.ts';

const SCHEMA_DIR = join(import.meta.dirname, '..', 'schemas');

const ajv = createOrchestratorAjv();

function loadSchema(filename: string): object {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, filename), 'utf8')) as object;
}

const backlogValidator = ajv.compile(loadSchema('backlog.schema.json'));
const agentsValidator = ajv.compile(loadSchema('agents.schema.json'));
const claimsValidator = ajv.compile(loadSchema('claims.schema.json'));
const runWorktreesValidator = ajv.compile(loadSchema('run-worktrees.schema.json'));

interface AjvError {
  instancePath?: string;
  dataPath?: string;
  message?: string;
}

function formatAjvErrors(prefix: string, errors: AjvError[] | null | undefined): string[] {
  return (errors ?? []).map((err) => {
    const pathRaw = err.instancePath ?? err.dataPath ?? '';
    const path = pathRaw && pathRaw.length > 0 ? pathRaw : '(root)';
    return `${prefix}: ${path} ${err.message}`;
  });
}

/** Validate backlog.json structure. Returns array of error strings (empty = valid). */
export function validateBacklog(data: unknown): string[] {
  const ok = backlogValidator(data);
  return ok ? [] : formatAjvErrors('backlog', backlogValidator.errors as AjvError[] | null);
}

/** Validate agents.json structure. Returns array of error strings. */
export function validateAgents(data: unknown): string[] {
  const ok = agentsValidator(data);
  return ok ? [] : formatAjvErrors('agents', agentsValidator.errors as AjvError[] | null);
}

/** Validate claims.json structure. Returns array of error strings. */
export function validateClaims(data: unknown): string[] {
  const ok = claimsValidator(data);
  return ok ? [] : formatAjvErrors('claims', claimsValidator.errors as AjvError[] | null);
}

export function validateRunWorktrees(data: unknown): string[] {
  const ok = runWorktreesValidator(data);
  return ok ? [] : formatAjvErrors('run-worktrees', runWorktreesValidator.errors as AjvError[] | null);
}

interface BacklogLike {
  epics?: Array<{ tasks?: Array<{ ref?: string }> }>;
}

interface AgentsLike {
  agents?: Array<{ agent_id?: string }>;
}

interface ClaimsLike {
  claims?: Array<{ run_id?: string; state?: string; task_ref?: string; agent_id?: string }>;
}

function validateStateInvariants(backlog: unknown, agents: unknown, claims: unknown): string[] {
  const errors: string[] = [];
  const taskRefs = new Set<string>();
  const agentIds = new Set<string>();
  const activeTaskClaims = new Map<string, string[]>();

  const b = backlog as BacklogLike | null;
  const ag = agents as AgentsLike | null;
  const cl = claims as ClaimsLike | null;

  for (const epic of b?.epics ?? []) {
    for (const task of epic?.tasks ?? []) {
      if (!task?.ref) continue;
      taskRefs.add(task.ref);
    }
  }

  for (const agent of ag?.agents ?? []) {
    if (agent?.agent_id) agentIds.add(agent.agent_id);
  }

  const ACTIVE_STATES = ['claimed', 'in_progress'];

  for (const claim of cl?.claims ?? []) {
    if (!claim?.run_id) continue;
    // Only enforce referential integrity for active claims — terminal claims
    // (done, failed, released) are historical records; their agents and tasks
    // may have been deregistered or removed after the run completed.
    if (claim.state && ACTIVE_STATES.includes(claim.state)) {
      if (claim.task_ref && !taskRefs.has(claim.task_ref)) {
        errors.push(`invariant: claim ${claim.run_id} references unknown task_ref "${claim.task_ref}"`);
      }
      if (claim.agent_id && !agentIds.has(claim.agent_id)) {
        errors.push(`invariant: claim ${claim.run_id} references unknown agent_id "${claim.agent_id}"`);
      }
    }
    if (claim.state && ACTIVE_STATES.includes(claim.state) && claim.task_ref) {
      const existing = activeTaskClaims.get(claim.task_ref) ?? [];
      existing.push(claim.run_id);
      activeTaskClaims.set(claim.task_ref, existing);
    }
  }

  for (const [taskRef, runIds] of activeTaskClaims.entries()) {
    if (runIds.length > 1) {
      errors.push(`invariant: multiple active claims for task ${taskRef}: ${runIds.join(', ')}`);
    }
  }

  return errors;
}

/**
 * Validate all state files in stateDir.
 * Returns array of error strings across all files (empty = all valid).
 */
export function validateStateDir(stateDir: string): string[] {
  const validators: Array<[string, (data: unknown) => string[]]> = [
    ['backlog.json', validateBacklog],
    ['agents.json', validateAgents],
    ['claims.json', validateClaims],
  ];

  const allErrors: string[] = [];
  const parsed: Record<string, unknown> = {};

  for (const [filename, validator] of validators) {
    const filePath = join(stateDir, filename);
    if (!existsSync(filePath)) {
      allErrors.push(`${filename}: file not found`);
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (err) {
      allErrors.push(`${filename}: JSON parse error — ${(err as Error).message}`);
      continue;
    }
    parsed[filename] = data;
    allErrors.push(...validator(data));
  }

  if (
    parsed['backlog.json']
    && parsed['agents.json']
    && parsed['claims.json']
  ) {
    allErrors.push(
      ...validateStateInvariants(
        parsed['backlog.json'],
        parsed['agents.json'],
        parsed['claims.json'],
      ),
    );
  }

  const eventsPath = join(stateDir, 'events.jsonl');
  if (!existsSync(eventsPath)) {
    allErrors.push('events.jsonl: file not found');
  } else {
    try {
      readEvents(eventsPath);
    } catch (error) {
      allErrors.push(`events.jsonl: ${(error as Error).message}`);
    }
  }

  const runWorktreesPath = join(stateDir, 'run-worktrees.json');
  if (existsSync(runWorktreesPath)) {
    try {
      const data: unknown = JSON.parse(readFileSync(runWorktreesPath, 'utf8'));
      allErrors.push(...validateRunWorktrees(data));
    } catch (error) {
      allErrors.push(`run-worktrees.json: JSON parse error — ${(error as Error).message}`);
    }
  }

  return allErrors;
}
