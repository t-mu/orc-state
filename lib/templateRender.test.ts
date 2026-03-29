import { describe, it, expect } from 'vitest';
import { renderTemplate } from './templateRender.ts';
import { TOOLS } from '../mcp/tools-list.ts';

describe('renderTemplate', () => {
  it('renders known placeholders and leaves no raw markers', () => {
    const rendered = renderTemplate('worker-bootstrap-v2.txt', {
      agent_id: 'bob',
      orc_bin: 'orc',
      provider: 'codex',
      session_token: 'token-1',
    });
    expect(rendered).toContain('agent_id: bob');
    expect(rendered).toContain('provider: codex');
    expect(rendered).not.toContain('{{');
  });

  it('renders master bootstrap with substituted agent and provider', () => {
    const rendered = renderTemplate('master-bootstrap-v1.txt', {
      agent_id: 'master',
      provider: 'claude',
    });
    expect(rendered).toContain('agent_id: master');
    expect(rendered).toContain('provider: claude');
    expect(rendered).not.toContain('{{agent_id}}');
    expect(rendered).not.toContain('{{provider}}');
  });

  it('documents every MCP tool in master bootstrap template', () => {
    const rendered = renderTemplate('master-bootstrap-v1.txt', {
      agent_id: 'master',
      provider: 'claude',
    });
    for (const tool of TOOLS) {
      expect(rendered, `bootstrap should mention tool ${tool.name}`).toContain(tool.name);
    }
  });

  it('keeps master bootstrap MCP-first without CLI command instructions', () => {
    const rendered = renderTemplate('master-bootstrap-v1.txt', {
      agent_id: 'master',
      provider: 'claude',
    });
    expect(rendered).toContain('orc run-start');
    expect(rendered).toContain('orc run-heartbeat');
    expect(rendered).toContain('orc run-work-complete');
    expect(rendered).toContain('orc run-finish');
    expect(rendered).toContain('orc run-fail');
    expect(rendered).not.toContain('orc status');
    expect(rendered).not.toContain('orc-progress');
  });

  it('renders task-scoped worker bootstrap language', () => {
    const rendered = renderTemplate('worker-bootstrap-v2.txt', {
      agent_id: 'worker-01',
      orc_bin: '/tmp/node_modules/.bin/orc',
      provider: 'codex',
      session_token: 'token-2',
    });
    expect(rendered).toContain('task-scoped orchestration worker');
    expect(rendered).toContain('one task run');
    expect(rendered).toContain('assigned worktree');
    expect(rendered).toContain('/tmp/node_modules/.bin/orc run-work-complete');
    expect(rendered).toContain('/tmp/node_modules/.bin/orc run-input-request');
    expect(rendered).toContain('Do not merge to main');
    expect(rendered).not.toContain('keeps it alive while you are registered');
  });

  it('renders enriched task envelope context for fresh workers', () => {
    const rendered = renderTemplate('task-envelope-v2.txt', {
      task_ref: 'orch/task-142',
      run_id: 'run-1',
      title: 'Task 142',
      feature: 'orch',
      description: 'bootstrap redesign',
      agent_id: 'orc-1',
      orc_bin: '/tmp/node_modules/.bin/orc',
      acceptance_criteria_lines: '  1. first',
      current_state: 'Current state text.',
      desired_state: 'Desired state text.',
      start_here: '- coordinator.mjs',
      files_to_change: '- coordinator.mjs',
      avoid_reading: 'lib/masterPtyForwarder.ts',
      implementation_notes: '- keep the patch surgical',
      verification: '```bash\nnpx vitest\n```',
      task_spec_path: 'docs/backlog/142-redesign-fresh-worker-bootstrap-and-run-contract.md',
      assigned_worktree: '/tmp/orc-worktrees/run-1',
      task_contract_json: '{}',
    });
    expect(rendered).toContain('current_state:');
    expect(rendered).toContain('desired_state:');
    expect(rendered).toContain('start_here:');
    expect(rendered).toContain('files_to_change:');
    expect(rendered).toContain('avoid_reading:');
    expect(rendered).toContain('implementation_notes:');
    expect(rendered).toContain('targeted_verification:');
    expect(rendered).toContain('task_spec_path: docs/backlog/142-redesign-fresh-worker-bootstrap-and-run-contract.md');
    expect(rendered).toContain('assigned_worktree: /tmp/orc-worktrees/run-1');
    expect(rendered).toContain('/tmp/node_modules/.bin/orc run-work-complete');
    expect(rendered).toContain('/tmp/node_modules/.bin/orc run-input-request');
    expect(rendered).toContain('remain alive for coordinator finalization follow-up when present');
    expect(rendered).not.toContain('worktree_setup: git worktree add');
  });
});
