import { describe, it, expect } from 'vitest';
import {
  taskTypeOf,
  canAgentExecuteTaskType,
  canAgentExecuteTask,
  evaluateTaskEligibility,
} from './taskRouting.ts';

describe('taskTypeOf', () => {
  it('defaults to implementation when task_type is missing', () => {
    expect(taskTypeOf({})).toBe('implementation');
  });

  it('returns explicit task_type', () => {
    expect(taskTypeOf({ task_type: 'refactor' })).toBe('refactor');
  });
});

describe('canAgentExecuteTaskType', () => {
  it('allows known task types for worker role', () => {
    expect(canAgentExecuteTaskType('implementation', { role: 'worker' })).toBe(true);
    expect(canAgentExecuteTaskType('refactor', { role: 'worker' })).toBe(true);
  });

  it('returns false for all task types for master role', () => {
    expect(canAgentExecuteTaskType('implementation', { role: 'master' })).toBe(false);
    expect(canAgentExecuteTaskType('refactor', { role: 'master' })).toBe(false);
  });

  it('returns false for all task types for scout role', () => {
    expect(canAgentExecuteTaskType('implementation', { role: 'scout' })).toBe(false);
    expect(canAgentExecuteTaskType('refactor', { role: 'scout' })).toBe(false);
  });

  it('returns false for unknown task types', () => {
    expect(canAgentExecuteTaskType('unknown', { role: 'worker' })).toBe(false);
  });
});

describe('canAgentExecuteTask', () => {
  it('combines task type + provider routing', () => {
    expect(canAgentExecuteTask(
      { task_type: 'refactor', required_provider: 'codex' },
      { role: 'reviewer', provider: 'codex' },
    )).toBe(true);

    expect(canAgentExecuteTask(
      { task_type: 'implementation', required_provider: 'codex' },
      { role: 'worker', provider: 'claude' },
    )).toBe(false);
  });
});

describe('evaluateTaskEligibility', () => {
  it('rejects master role with a role_ineligible reason', () => {
    expect(evaluateTaskEligibility(
      { task_type: 'implementation' },
      { agent_id: 'master', role: 'master' },
    )).toEqual({
      eligible: false,
      reasons: ['role_ineligible:master'],
      reason_details: [{
        code: 'role_ineligible:master',
        message: "agent role 'master' cannot execute routed tasks",
      }],
    });
  });

  it('rejects scout role with a role_ineligible reason', () => {
    expect(evaluateTaskEligibility(
      { task_type: 'implementation' },
      { agent_id: 'scout-1', role: 'scout' },
    )).toEqual({
      eligible: false,
      reasons: ['role_ineligible:scout'],
      reason_details: [{
        code: 'role_ineligible:scout',
        message: "agent role 'scout' cannot execute routed tasks",
      }],
    });
  });

  it('rejects unsupported task types with a stable reason', () => {
    expect(evaluateTaskEligibility(
      { task_type: 'planning' },
      { agent_id: 'orc-1', role: 'worker' },
    )).toEqual({
      eligible: false,
      reasons: ['unsupported_task_type:planning'],
      reason_details: [{
        code: 'unsupported_task_type:planning',
        message: "unsupported task type 'planning'",
      }],
    });
  });

  it('rejects reserved owner conflicts when task is assigned to another agent', () => {
    expect(evaluateTaskEligibility(
      { task_type: 'implementation', owner: 'orc-2' },
      { agent_id: 'orc-1', role: 'worker' },
    )).toEqual({
      eligible: false,
      reasons: ['reserved_owner_conflict:orc-2'],
      reason_details: [{
        code: 'reserved_owner_conflict:orc-2',
        message: "task is reserved for owner 'orc-2'",
      }],
    });
  });

  it('rejects provider mismatch with a stable reason', () => {
    expect(evaluateTaskEligibility(
      { task_type: 'implementation', required_provider: 'gemini' },
      { agent_id: 'orc-1', role: 'worker', provider: 'codex' },
    )).toEqual({
      eligible: false,
      reasons: ['provider_mismatch:gemini'],
      reason_details: [{
        code: 'provider_mismatch:gemini',
        message: "task requires provider 'gemini'",
      }],
    });
  });

  it('returns no reasons for a valid task-agent pair', () => {
    expect(evaluateTaskEligibility(
      { task_type: 'refactor', required_provider: 'codex' },
      { agent_id: 'orc-1', role: 'worker', provider: 'codex' },
    )).toEqual({
      eligible: true,
      reasons: [],
      reason_details: [],
    });
  });
});
