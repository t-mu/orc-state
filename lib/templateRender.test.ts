import { describe, it, expect } from 'vitest';
import { renderTemplate } from './templateRender.ts';
import { TOOLS } from '../mcp/tools-list.ts';
import { buildSessionBootstrap } from './sessionBootstrap.ts';

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

  it('tells the worker which --reviewer label each reviewer submits with', () => {
    const light = buildSessionBootstrap('bob', 'claude', 'worker', 'orc', 't', { reviewLevel: 'light' });
    const full = buildSessionBootstrap('bob', 'claude', 'worker', 'orc', 't', { reviewLevel: 'full' });
    expect(light).toContain('review-submit --run-id=<run_id> --agent-id=bob');
    expect(light).toContain('<reviewer_label> replaced by `reviewer`');
    expect(full).toContain('<reviewer_label> replaced by `critic`');
    expect(full).toContain('`integrator` for the other');
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

  it('names only MCP tools that exist', () => {
    const rendered = renderTemplate('master-bootstrap-v1.txt', {
      agent_id: 'master',
      provider: 'claude',
    });
    const toolNames = new Set(TOOLS.map((tool) => tool.name));
    // Snake_case identifiers the bootstrap uses that are not tools: event types and payload fields.
    const nonTools = new Set([
      'agent_id', 'after_seq', 'body_markdown', 'event_type', 'has_more', 'idle_ms', 'input_requested', 'input_response',
      'last_notification_seq', 'last_seq', 'no_progress', 'notifications_only', 'permission_prompt',
      'phase_started', 'provider_interactive_prompt', 'remediation_policy', 'run_cancelled', 'run_failed',
      'run_finished', 'session_not_running', 'waiting_input', 'worker_needs_attention',
    ]);
    const mentioned = [...new Set(rendered.match(/\b[a-z]+(?:_[a-z]+)+\b/g))];
    expect(mentioned.filter((name) => toolNames.has(name)).length).toBeGreaterThan(10);
    expect(mentioned.filter((name) => !toolNames.has(name) && !nonTools.has(name))).toEqual([]);
  });

  it('keeps the master bootstrap within 6 KB without restating tool parameters', () => {
    const rendered = renderTemplate('master-bootstrap-v1.txt', {
      agent_id: 'master',
      provider: 'claude',
    });
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(6 * 1024);
    // Signatures like create_task(title, body_markdown?, ...) belong to tools-list.ts.
    expect(rendered).not.toMatch(/\b[a-z_]+\([a-z_]+\?/);
    expect(rendered).not.toContain('Returns {');
  });

  it('batches successful runs and explains provider permission prompts', () => {
    const rendered = renderTemplate('master-bootstrap-v1.txt', {
      agent_id: 'master',
      provider: 'claude',
    });
    expect(rendered).not.toContain('1) Ignore');
    expect(rendered).toContain('together in one short summary');
    expect(rendered).toContain('remediation_policy:permission_prompt');
    expect(rendered).toContain('orc attach <agent_id> --write');
    expect(rendered).toContain('list_runs(state="waiting_input")');
    expect(rendered).toContain('restart_coordinator');
    expect(rendered).toContain('coordinator.stale');
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
    const rendered = buildSessionBootstrap('worker-01', 'codex', 'worker', '/tmp/node_modules/.bin/orc', 'token-2');
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
    for (const mergeStrategy of ['direct', 'pr'] as const) {
      const rendered = buildSessionBootstrap('w', 'claude', 'worker', 'orc', 't', { mergeStrategy, reviewLevel: 'full' });
      for (const tool of TOOLS) expect(rendered, `${mergeStrategy} worker bootstrap mentions MCP tool ${tool.name}`).not.toMatch(new RegExp(`\\b${tool.name}\\b`));
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
