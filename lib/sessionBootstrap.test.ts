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

  it('returns codex master template content', () => {
    const rendered = getMasterBootstrap('codex');
    expect(rendered).toBe(renderTemplate('master-bootstrap-codex-v1.txt', {
      agent_id: 'master',
      provider: 'codex',
    }));
  });

  it('returns gemini master template content', () => {
    const rendered = getMasterBootstrap('gemini');
    expect(rendered).toBe(renderTemplate('master-bootstrap-gemini-v1.txt', {
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
    expect(content).toContain('orc task-mark-done');
    expect(content).toContain('MAX_DEPTH=1');
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
