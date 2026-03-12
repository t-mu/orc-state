import { describe, it, expect } from 'vitest';
import {
  taskTypeOf,
  hasRequiredCapabilities,
  canAgentExecuteTaskType,
  canAgentExecuteTask,
  evaluateTaskEligibility,
} from './taskRouting.mjs';

describe('taskTypeOf', () => {
  it('defaults to implementation when task_type is missing', () => {
    expect(taskTypeOf({})).toBe('implementation');
  });

  it('returns explicit task_type', () => {
    expect(taskTypeOf({ task_type: 'refactor' })).toBe('refactor');
  });
});

describe('hasRequiredCapabilities', () => {
  it('passes when no required capabilities', () => {
    expect(hasRequiredCapabilities({}, { capabilities: [] })).toBe(true);
  });

  it('passes when all required capabilities exist', () => {
    expect(hasRequiredCapabilities(
      { required_capabilities: ['refactor', 'review'] },
      { capabilities: ['refactor', 'review', 'extra'] },
    )).toBe(true);
  });

  it('fails when any required capability is missing', () => {
    expect(hasRequiredCapabilities(
      { required_capabilities: ['refactor', 'review'] },
      { capabilities: ['refactor'] },
    )).toBe(false);
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

  it('returns false for unknown task types', () => {
    expect(canAgentExecuteTaskType('unknown', { role: 'worker' })).toBe(false);
  });
});

describe('canAgentExecuteTask', () => {
  it('combines task type + required capabilities', () => {
    expect(canAgentExecuteTask(
      { task_type: 'refactor', required_capabilities: ['refactor'] },
      { role: 'reviewer', capabilities: ['refactor'] },
    )).toBe(true);

    expect(canAgentExecuteTask(
      { task_type: 'implementation', required_capabilities: ['sql'] },
      { role: 'worker', capabilities: [] },
    )).toBe(false);
  });
});

describe('evaluateTaskEligibility', () => {
  it('explains capability mismatch with a stable reason', () => {
    expect(evaluateTaskEligibility(
      { task_type: 'implementation', required_capabilities: ['typescript'] },
      { agent_id: 'orc-1', role: 'worker', capabilities: [] },
    )).toEqual({
      eligible: false,
      reasons: ['missing_capability:typescript'],
      reason_details: [{
        code: 'missing_capability:typescript',
        message: "missing required capability 'typescript'",
      }],
    });
  });

  it('rejects master role with a role_ineligible reason', () => {
    expect(evaluateTaskEligibility(
      { task_type: 'implementation' },
      { agent_id: 'master', role: 'master', capabilities: [] },
    )).toEqual({
      eligible: false,
      reasons: ['role_ineligible:master'],
      reason_details: [{
        code: 'role_ineligible:master',
        message: "agent role 'master' cannot execute routed tasks",
      }],
    });
  });

  it('rejects unsupported task types with a stable reason', () => {
    expect(evaluateTaskEligibility(
      { task_type: 'planning' },
      { agent_id: 'orc-1', role: 'worker', capabilities: [] },
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
      { agent_id: 'orc-1', role: 'worker', capabilities: [] },
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
      { agent_id: 'orc-1', role: 'worker', provider: 'codex', capabilities: [] },
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
      { task_type: 'refactor', required_capabilities: ['sql'], required_provider: 'codex' },
      { agent_id: 'orc-1', role: 'worker', provider: 'codex', capabilities: ['sql'] },
    )).toEqual({
      eligible: true,
      reasons: [],
      reason_details: [],
    });
  });
});
