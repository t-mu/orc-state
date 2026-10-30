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
    expect(rendered).toContain('orc progress');
    expect(rendered).not.toContain('orc run-heartbeat');
    expect(rendered).toContain('reset_task, which cancels its run');
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

  it('keeps the placeholder get_scout_report uses to tell the echoed report template from a truncated report', () => {
    for (const template of ['scout-bootstrap-v1.txt', 'scout-brief-v1.txt']) {
      const text = renderTemplate(template, { agent_id: 's', orc_bin: 'orc', provider: 'claude', session_token: 't' });
      expect(text, template).toMatch(/<concrete next step[^\n]*\nSCOUT_REPORT_END/);
    }
  });

  it('never points a worker or scout at an MCP tool, since they start without the orchestrator server', () => {
    const vars = { agent_id: 'w', orc_bin: 'orc', provider: 'claude', session_token: 't' };
    for (const template of ['worker-bootstrap-v2.txt', 'scout-bootstrap-v1.txt', 'scout-brief-v1.txt', 'task-envelope-v2.txt']) {
      const rendered = renderTemplate(template, vars);
      for (const tool of TOOLS) expect(rendered, `${template} mentions MCP tool ${tool.name}`).not.toMatch(new RegExp(`\\b${tool.name}\\b`));
    }
  });

  it('renders compact task envelope context for fresh workers', () => {
    const rendered = renderTemplate('task-envelope-v2.txt', {
      task_ref: 'orch/task-142',
      run_id: 'run-1',
      task_spec_path: 'docs/backlog/142-redesign-fresh-worker-bootstrap-and-run-contract.md',
      assigned_worktree: '/tmp/orc-worktrees/run-1',
    });
    expect(rendered).toContain('TASK_START v4');
    expect(rendered).toContain('task_ref: orch/task-142');
    expect(rendered).toContain('run_id: run-1');
    expect(rendered).toContain('task_spec_path: docs/backlog/142-redesign-fresh-worker-bootstrap-and-run-contract.md');
    expect(rendered).toContain('assigned_worktree: /tmp/orc-worktrees/run-1');
    expect(rendered).toContain('TASK_END');
    expect(rendered).not.toContain('acceptance_criteria:');
    expect(rendered).not.toContain('task_contract_v1_json:');
    expect(rendered).not.toContain('run-work-complete');
    expect(rendered).not.toContain('run-input-request');
  });
});
