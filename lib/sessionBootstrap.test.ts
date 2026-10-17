import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  buildSessionBootstrap,
  getMasterBootstrap,
  getScoutBootstrap,
  getWorkerBootstrap,
} from './sessionBootstrap.ts';
import { renderTemplate } from './templateRender.ts';

describe('getWorkerBootstrap', () => {
  it('returns non-empty string for claude', () => {
    const rendered = getWorkerBootstrap('claude');
    expect(rendered).toContain('provider: claude');
    expect(rendered).toContain('agent_id: worker');
    expect(rendered).toContain('orc run-start');
  });

  it('throws for unknown provider', () => {
    expect(() => getWorkerBootstrap('unknown')).toThrow('Unsupported bootstrap provider');
  });
});

describe('getMasterBootstrap', () => {
  it('returns non-empty string for claude', () => {
    const rendered = getMasterBootstrap('claude');
    expect(rendered).toContain('provider: claude');
    expect(rendered).toContain('agent_id: master');
  });

  it('returns same master-bootstrap-v1.txt template for codex', () => {
    const rendered = getMasterBootstrap('codex');
    expect(rendered).toBe(renderTemplate('master-bootstrap-v1.txt', {
      agent_id: 'master',
      provider: 'codex',
    }));
  });

  it('returns same master-bootstrap-v1.txt template for gemini', () => {
    const rendered = getMasterBootstrap('gemini');
    expect(rendered).toBe(renderTemplate('master-bootstrap-v1.txt', {
      agent_id: 'master',
      provider: 'gemini',
    }));
  });
});

describe('getScoutBootstrap', () => {
  it('returns non-empty string for codex', () => {
    const rendered = getScoutBootstrap('codex');
    expect(rendered).toContain('provider: codex');
    expect(rendered).toContain('agent_id: scout');
    expect(rendered).toContain('investigation-only agent');
    expect(rendered).toContain('read-only sandbox mode');
  });
});

describe('buildSessionBootstrap', () => {
  it('uses master-bootstrap-v1.txt for master role', () => {
    const rendered = buildSessionBootstrap('master', 'claude', 'master');
    expect(rendered).toContain('MASTER_BOOTSTRAP');
    expect(rendered).toContain('agent_id: master');
  });

  it('renders coordinator-owned finalization guidance for worker role', () => {
    const rendered = buildSessionBootstrap('bob', 'claude', 'worker', '/tmp/node_modules/.bin/orc', 'token-123');
    expect(rendered).toContain('task-scoped orchestration worker');
    expect(rendered).toContain('assigned worktree');
    expect(rendered).toContain('/tmp/node_modules/.bin/orc run-work-complete');
    expect(rendered).toContain('/tmp/node_modules/.bin/orc run-input-request');
    expect(rendered).toContain('/tmp/node_modules/.bin/orc report-for-duty --agent-id=bob --session-token=token-123');
    expect(rendered).toContain('Do not merge to main');
    expect(rendered).not.toContain('git worktree add .worktrees/<run_id>');
  });

  it('uses worker-bootstrap-v2.txt for reviewer role', () => {
    const rendered = buildSessionBootstrap('carol', 'codex', 'reviewer', '/usr/local/bin/orc', 'token-456');
    expect(rendered).toContain('provider: codex');
    expect(rendered).toContain('/usr/local/bin/orc run-work-complete');
    expect(rendered).toContain('session_token: token-456');
  });

  it('uses smoke worker bootstrap when requested explicitly', () => {
    const rendered = buildSessionBootstrap('smoke-worker', 'codex', 'worker', '/usr/local/bin/orc', 'token-smoke', {
      workerBootstrapProfile: 'smoke',
    });
    expect(rendered).toContain('WORKER_BOOTSTRAP_SMOKE');
    expect(rendered).toContain('Do NOT spawn sub-agents in this smoke profile.');
    expect(rendered).not.toContain('REVIEWER CONSTRAINTS');
  });

  it('uses the default worker bootstrap when no smoke profile is requested', () => {
    const rendered = buildSessionBootstrap('worker-1', 'codex', 'worker', '/usr/local/bin/orc', 'token-default');
    expect(rendered).not.toContain('WORKER_BOOTSTRAP_SMOKE');
    expect(rendered).toContain('WORKER_BOOTSTRAP');
  });

  it('emits attached-mode Phase 4 (worker edits the spec) when siblingLayout is false', () => {
    const rendered = buildSessionBootstrap('bob', 'claude', 'worker', 'orc', 'token', { siblingLayout: false });
    // Attached mode edits the worktree copy, never the pinned run snapshot.
    const expectedStep7 = [
      '  7. Signal complete phase and update the task markdown in this assigned worktree to `status: done`:',
      '       orc progress --event=phase_started --phase=complete --run-id=<run_id> --agent-id=bob',
      '       - Edit the task spec file referenced by `task_spec_worktree_path` (the pinned `task_spec_path` is read-only)',
      '       - Change its frontmatter `status:` field to `done`',
      '       - Do not call `orc task-mark-done` from the worker session; the coordinator marks shared runtime state done after merge',
    ].join('\n');
    expect(rendered).toContain(expectedStep7);
    // No placeholder leaks and no sibling-only prohibition.
    expect(rendered).not.toContain('{{phase_complete_step}}');
    expect(rendered).not.toContain('Never commit framework files');
  });

  it('emits sibling-mode Phase 4 (coordinator writes back; no spec edit) when siblingLayout is true', () => {
    const rendered = buildSessionBootstrap('bob', 'claude', 'worker', 'orc', 'token', { siblingLayout: true });
    expect(rendered).toContain('the coordinator records completion after merge — do NOT edit the task spec');
    expect(rendered).toContain('Never commit framework files');
    expect(rendered).toContain('coordinator writes `status: done` back into the orchestration backlog after merge');
    // Sibling mode omits the worker-edits-spec instructions.
    expect(rendered).not.toContain('Edit the task spec file referenced by `task_spec_path`');
    expect(rendered).not.toContain('Change its frontmatter `status:` field to `done`');
    expect(rendered).not.toContain('{{phase_complete_step}}');
  });

  it('interpolates orc_bin into the injected Phase 4 step (no leftover placeholder)', () => {
    const rendered = buildSessionBootstrap('bob', 'claude', 'worker', '/custom/orc', 'token', { siblingLayout: true });
    expect(rendered).toContain('/custom/orc progress --event=phase_started --phase=complete');
    expect(rendered).not.toContain('{{orc_bin}}');
  });

  it('uses scout-bootstrap-v1.txt for scout role', () => {
    const rendered = buildSessionBootstrap('scout-1', 'codex', 'scout', 'orc', 'scout-token');
    expect(rendered).toContain('SCOUT_BOOTSTRAP');
    expect(rendered).toContain('agent_id: scout-1');
    expect(rendered).toContain('investigation-only agent');
    expect(rendered).toContain('orc report-for-duty --agent-id=scout-1 --session-token=scout-token');
    expect(rendered).not.toContain('orc run-work-complete');
  });

  it('worker bootstrap template contains REVIEWER CONSTRAINTS block', () => {
    const content = readFileSync('templates/worker-bootstrap-v2.txt', 'utf8');
    expect(content).toContain('REVIEWER CONSTRAINTS');
    expect(content).toContain('orc run-finish');
    expect(content).toContain('MAX_DEPTH=1');
  });

  it('rendered worker bootstrap keeps the task-mark-done prohibition in both layouts', () => {
    // The prohibition moved from the raw template into the injected Phase 4 step.
    for (const siblingLayout of [false, true]) {
      const rendered = buildSessionBootstrap('bob', 'claude', 'worker', 'orc', 'tok', { siblingLayout });
      expect(rendered).toContain('Do not call `orc task-mark-done`');
    }
  });

  it('rendered bootstrap contains memory-wake-up call', () => {
    const rendered = buildSessionBootstrap('bob', 'claude', 'worker', 'orc', 'tok');
    expect(rendered).toContain('memory-wake-up');
  });

  it('memory-wake-up call includes wing variable derived from task_ref', () => {
    const rendered = buildSessionBootstrap('bob', 'claude', 'worker', 'orc', 'tok');
    expect(rendered).toContain('WING=$(echo "<task_ref>" | cut -d\'/\' -f1)');
    expect(rendered).toContain('memory-wake-up --wing="$WING"');
  });

  it('memory-wake-up call is non-fatal (wrapped with || true)', () => {
    const rendered = buildSessionBootstrap('bob', 'claude', 'worker', 'orc', 'tok');
    expect(rendered).toMatch(/memory-wake-up.*\|\| true/);
  });

  it('rendered bootstrap instructs workers to use memory-record during implementation', () => {
    const rendered = buildSessionBootstrap('bob', 'claude', 'worker', 'orc', 'tok');
    expect(rendered).toContain('memory-record');
  });

  it('uses worker-bootstrap-v2.txt when role is undefined', () => {
    const rendered = buildSessionBootstrap('dave', 'claude', undefined as unknown as string, 'orc');
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
