import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents } from './eventLog.mjs';
import { createOrchestratorAjv } from './ajvFactory.mjs';

const SCHEMA_DIR = join(import.meta.dirname, '..', 'schemas');

const ajv = createOrchestratorAjv();

function loadSchema(filename) {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, filename), 'utf8'));
}

const backlogValidator = ajv.compile(loadSchema('backlog.schema.json'));
const agentsValidator = ajv.compile(loadSchema('agents.schema.json'));
const claimsValidator = ajv.compile(loadSchema('claims.schema.json'));
const runWorktreesValidator = ajv.compile(loadSchema('run-worktrees.schema.json'));

function formatAjvErrors(prefix, errors) {
  return (errors ?? []).map((err) => {
    const pathRaw = err.instancePath ?? err.dataPath ?? '';
    const path = pathRaw && pathRaw.length > 0 ? pathRaw : '(root)';
    return `${prefix}: ${path} ${err.message}`;
  });
}

/** Validate backlog.json structure. Returns array of error strings (empty = valid). */
export function validateBacklog(data) {
  const ok = backlogValidator(data);
  return ok ? [] : formatAjvErrors('backlog', backlogValidator.errors);
}

/** Validate agents.json structure. Returns array of error strings. */
export function validateAgents(data) {
  const ok = agentsValidator(data);
  return ok ? [] : formatAjvErrors('agents', agentsValidator.errors);
}

/** Validate claims.json structure. Returns array of error strings. */
export function validateClaims(data) {
  const ok = claimsValidator(data);
  return ok ? [] : formatAjvErrors('claims', claimsValidator.errors);
}

export function validateRunWorktrees(data) {
  const ok = runWorktreesValidator(data);
  return ok ? [] : formatAjvErrors('run-worktrees', runWorktreesValidator.errors);
}

function validateStateInvariants(backlog, agents, claims) {
  const errors = [];
  const taskRefs = new Set();
  const agentIds = new Set();
  const activeTaskClaims = new Map();

  for (const epic of backlog?.epics ?? []) {
    for (const task of epic?.tasks ?? []) {
      if (!task?.ref) continue;
      taskRefs.add(task.ref);
    }
  }

  for (const agent of agents?.agents ?? []) {
    if (agent?.agent_id) agentIds.add(agent.agent_id);
  }

  const ACTIVE_STATES = ['claimed', 'in_progress'];

  for (const claim of claims?.claims ?? []) {
    if (!claim?.run_id) continue;
    // Only enforce referential integrity for active claims — terminal claims
    // (done, failed, released) are historical records; their agents and tasks
    // may have been deregistered or removed after the run completed.
    if (ACTIVE_STATES.includes(claim.state)) {
      if (!taskRefs.has(claim.task_ref)) {
        errors.push(`invariant: claim ${claim.run_id} references unknown task_ref "${claim.task_ref}"`);
      }
      if (!agentIds.has(claim.agent_id)) {
        errors.push(`invariant: claim ${claim.run_id} references unknown agent_id "${claim.agent_id}"`);
      }
    }
    if (ACTIVE_STATES.includes(claim.state)) {
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
export function validateStateDir(stateDir) {
  const validators = [
    ['backlog.json', validateBacklog],
    ['agents.json', validateAgents],
    ['claims.json', validateClaims],
  ];

  const allErrors = [];
  const parsed = {};

  for (const [filename, validator] of validators) {
    const filePath = join(stateDir, filename);
    if (!existsSync(filePath)) {
      allErrors.push(`${filename}: file not found`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (err) {
      allErrors.push(`${filename}: JSON parse error — ${err.message}`);
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
      allErrors.push(`events.jsonl: ${error.message}`);
    }
  }

  const runWorktreesPath = join(stateDir, 'run-worktrees.json');
  if (existsSync(runWorktreesPath)) {
    try {
      const data = JSON.parse(readFileSync(runWorktreesPath, 'utf8'));
      allErrors.push(...validateRunWorktrees(data));
    } catch (error) {
      allErrors.push(`run-worktrees.json: JSON parse error — ${error.message}`);
    }
  }

  return allErrors;
}
