import { describe, it, expect } from 'vitest';
import { buildSessionBootstrap } from './sessionBootstrap.ts';

describe('buildSessionBootstrap', () => {
  it('uses master-bootstrap-v1.txt for master role', () => {
    const rendered = buildSessionBootstrap('master', 'claude', 'master');
    expect(rendered).toContain('MASTER_BOOTSTRAP');
    expect(rendered).toContain('agent_id: master');
  });

  it('renders coordinator-owned finalization guidance for worker role', () => {
    const rendered = buildSessionBootstrap('bob', 'claude', 'worker');
    expect(rendered).toContain('task-scoped orchestration worker');
    expect(rendered).toContain('assigned worktree');
    expect(rendered).toContain('orc run-work-complete');
    expect(rendered).toContain('orc run-input-request');
    expect(rendered).toContain('Do not merge to main');
    expect(rendered).not.toContain('git worktree add .worktrees/<run_id>');
  });

  it('uses worker-bootstrap-v2.txt for reviewer role', () => {
    const rendered = buildSessionBootstrap('carol', 'codex', 'reviewer');
    expect(rendered).toContain('provider: codex');
    expect(rendered).toContain('orc run-work-complete');
  });

  it('uses worker-bootstrap-v2.txt when role is undefined', () => {
    const rendered = buildSessionBootstrap('dave', 'claude', undefined as unknown as string);
    expect(rendered).toContain('agent_id: dave');
    expect(rendered).toContain('coordinator finalization');
  });

  it('keeps master bootstrap path unchanged while documenting the new worker handoff', () => {
    const rendered = buildSessionBootstrap('master', 'codex', 'master');
    expect(rendered).toContain('provider: codex');
    expect(rendered).toContain('orc run-work-complete');
    expect(rendered).toContain('do not merge to main or clean up');
    expect(rendered).toContain('respond_input');
  });
});
