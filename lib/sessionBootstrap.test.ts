import { describe, it, expect } from 'vitest';
import {
  buildSessionBootstrap,
  getMasterBootstrap,
  getScoutBootstrap,
  getWorkerBootstrap,
  prReviewSteps,
} from './sessionBootstrap.ts';
import { renderTemplate } from './templateRender.ts';

describe('getWorkerBootstrap', () => {
  it('returns non-empty string for claude', () => {
    const rendered = getWorkerBootstrap('claude');
    expect(rendered).toContain('provider: claude');
    expect(rendered).toContain('agent_id: worker');
    expect(rendered).toContain('orc run-start');
  });

  it('states that the explore phase is read-only', () => {
    const rendered = getWorkerBootstrap('claude');
    expect(rendered).toContain(
      'Explore is read-only: send the implement phase signal before editing any file or running `npm test`.',
    );
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
    expect(rendered).toContain('Do not merge to main');
    expect(rendered).not.toContain('git worktree add .worktrees/<run_id>');
  });

  it('uses worker-bootstrap-v2.txt for reviewer role', () => {
    const rendered = buildSessionBootstrap('carol', 'codex', 'reviewer', '/usr/local/bin/orc', 'token-456');
    expect(rendered).toContain('provider: codex');
    expect(rendered).toContain('/usr/local/bin/orc run-work-complete');
    expect(rendered).toContain('session_id: token-456');
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

  it('emits one runtime-owned Phase 4 step: no worker edits a spec status', () => {
    const rendered = buildSessionBootstrap('bob', 'claude', 'worker', 'orc', 'token');
    const expectedStep7 = [
      '  7. Signal complete phase. Task status is runtime-owned — the coordinator records `done` after merge:',
      '       orc progress --event=phase_started --phase=complete --run-id=<run_id> --agent-id=bob',
      '       - Do NOT edit the `status:` field of any task spec; commit only the changes the task asks for, never orchestration state',
      '       - Do not call `orc task-mark-done` from the worker session',
    ].join('\n');
    expect(rendered).toContain(expectedStep7);
    expect(rendered).not.toContain('{{phase_complete_step}}');
    expect(rendered).not.toContain('Change its frontmatter `status:` field to `done`');
  });

  it('interpolates orc_bin into the injected Phase 4 step (no leftover placeholder)', () => {
    const rendered = buildSessionBootstrap('bob', 'claude', 'worker', '/custom/orc', 'token');
    expect(rendered).toContain('/custom/orc progress --event=phase_started --phase=complete');
    expect(rendered).not.toContain('{{orc_bin}}');
  });

  it.each(['claude', 'codex'])('never tells a %s worker or scout to report for duty: its session-start hook does', (provider) => {
    for (const role of ['worker', 'scout']) {
      const rendered = buildSessionBootstrap('bob', provider, role, '/tmp/node_modules/.bin/orc', 'token-123');
      expect(rendered, role).not.toContain('report-for-duty');
      expect(rendered, role).not.toContain('report for duty');
      expect(rendered, role).toContain('reports itself ready');
      expect(rendered, role).not.toContain('{{');
    }
    expect(getWorkerBootstrap(provider)).not.toContain('report-for-duty');
    expect(getScoutBootstrap(provider)).not.toContain('report-for-duty');
    const smoke = buildSessionBootstrap('bob', provider, 'worker', 'orc', 'token-123', { workerBootstrapProfile: 'smoke' });
    expect(smoke).toContain('WORKER_BOOTSTRAP_SMOKE');
    expect(smoke).not.toContain('report-for-duty');
  });

  it('tells a Gemini worker, scout and smoke worker (no session-start hook) to report for duty', () => {
    const rendered = buildSessionBootstrap('bob', 'gemini', 'worker', '/tmp/node_modules/.bin/orc', 'token-123');
    expect(rendered).toContain('Before waiting for the TASK_START, report that this exact session is ready');
    expect(rendered).toContain('/tmp/node_modules/.bin/orc report-for-duty --agent-id=bob --session-id=token-123');
    expect(rendered.split('report-for-duty').length - 1).toBe(1);
    expect(buildSessionBootstrap('scout-1', 'gemini', 'scout', 'orc', 'scout-token'))
      .toContain('orc report-for-duty --agent-id=scout-1 --session-id=scout-token');
    expect(buildSessionBootstrap('bob', 'gemini', 'worker', 'orc', 'token-123', { workerBootstrapProfile: 'smoke' }))
      .toContain('orc report-for-duty --agent-id=bob --session-id=token-123');
  });

  it('uses scout-bootstrap-v1.txt for scout role', () => {
    const rendered = buildSessionBootstrap('scout-1', 'codex', 'scout', 'orc', 'scout-token');
    expect(rendered).toContain('SCOUT_BOOTSTRAP');
    expect(rendered).toContain('agent_id: scout-1');
    expect(rendered).toContain('investigation-only agent');
    expect(rendered).toContain('Wait for the SCOUT_BRIEF');
    expect(rendered).not.toContain('orc run-work-complete');
  });

  it('a reviewed worker bootstrap contains the REVIEWER CONSTRAINTS block', () => {
    for (const reviewLevel of ['light', 'full'] as const) {
      const rendered = buildSessionBootstrap('bob', 'claude', 'worker', 'orc', 'tok', { reviewLevel });
      expect(rendered, reviewLevel).toContain('REVIEWER CONSTRAINTS');
      expect(rendered, reviewLevel).toContain('MAX_DEPTH=1');
      expect(rendered, reviewLevel).toContain('orc review-submit --run-id=<run_id> --agent-id=bob');
      expect(rendered, reviewLevel).toContain('REVIEW_FINDINGS_END');
      expect(rendered, reviewLevel).toContain('orc run-finish');
    }
  });

  it('rendered worker bootstrap keeps the task-mark-done prohibition', () => {
    // The prohibition moved from the raw template into the injected Phase 4 step.
    expect(buildSessionBootstrap('bob', 'claude', 'worker', 'orc', 'tok')).toContain('Do not call `orc task-mark-done`');
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
    expect(rendered).toContain('WORKER_BOOTSTRAP v5');
  });

  it('keeps master bootstrap path unchanged while documenting the new worker handoff', () => {
    const rendered = buildSessionBootstrap('master', 'codex', 'master');
    expect(rendered).toContain('provider: codex');
    expect(rendered).toContain('orc run-work-complete');
    expect(rendered).toContain('do not merge to main or clean up');
    expect(rendered).toContain('respond_input');
  });
});

describe('worker bootstrap: only the run\'s own workflow', () => {
  const PR_LOOP = ['pr-status', 'git push --force-with-lease', 'origin/main'];
  const render = (options: Parameters<typeof buildSessionBootstrap>[5], provider = 'claude') =>
    buildSessionBootstrap('w1', provider, 'worker', 'orc', 'sid', options);

  it('gives a direct-mode worker no PR-mode steps', () => {
    const rendered = render({ mergeStrategy: 'direct' });
    expect(rendered).toContain('merge mode: direct');
    expect(rendered).toContain('git rebase main');
    expect(rendered).toContain('finalize rebase');
    for (const text of PR_LOOP) expect(rendered, text).not.toContain(text);
    // A merge mode edited mid-run still reaches the worker: PR_REVIEW carries its own loop.
    expect(rendered).toContain('A PR_REVIEW message (the merge mode changed): follow the PR loop it carries.');
  });

  it('gives a PR-mode worker the PR_REVIEW wait and no direct-mode rebase or finalize-rebase steps', () => {
    const rendered = render({ mergeStrategy: 'pr' });
    expect(rendered).toContain('merge mode: pr');
    expect(rendered).toContain('wait in this session for a PR_REVIEW message; it carries the PR loop to follow');
    expect(rendered).toContain('If FINALIZE_REBASE or FINALIZE_SUCCESS arrives instead');
    expect(rendered).not.toContain('git rebase main ');
    expect(rendered).not.toContain('finalize rebase');
    for (const text of PR_LOOP) expect(rendered, text).not.toContain(text);
  });

  it('PR_REVIEW steps carry the whole PR loop for the review level they are sent with', () => {
    for (const level of ['none', 'light', 'full'] as const) {
      const steps = prReviewSteps(level, '/bin/orc', 'w1');
      for (const text of PR_LOOP) expect(steps, `${level}: ${text}`).toContain(text);
      expect(steps, level).toContain('review-fix loop exceeded 3 iterations');
      expect(steps, level).toContain('ci-fix loop exceeded 3 iterations');
      expect(steps, level).toContain('/bin/orc run-finish --run-id=<run_id> --agent-id=w1');
      expect(steps, level).not.toMatch(/\{\{/);
    }
    const none = prReviewSteps('none', 'orc', 'w1');
    expect(none).toContain('review_level none');
    expect(none).not.toContain('review-read');
    expect(none).not.toContain('REVIEWER CONSTRAINTS');
    const light = prReviewSteps('light', 'orc', 'w1');
    expect(light).toContain('label `reviewer`');
    expect(light).toContain('REVIEW_FINDINGS_END');
    expect(light).toContain('orc review-read --run-id=<run_id>');
    expect(light).not.toContain('`critic`');
    const full = prReviewSteps('full', 'orc', 'w1');
    expect(full).toContain('labels `critic` and `integrator`');
    expect(full).not.toContain('agents/reviewer.md');
  });

  it('defaults to direct mode and full review, as the coordinator does', () => {
    expect(render({})).toBe(render({ mergeStrategy: 'direct', reviewLevel: 'full' }));
  });

  it('review_level none: self-review only, no reviewer sub-agents, in either merge mode', () => {
    for (const mergeStrategy of ['direct', 'pr'] as const) {
      const rendered = render({ reviewLevel: 'none', mergeStrategy });
      expect(rendered, mergeStrategy).toContain('Self-review (review_level none)');
      expect(rendered, mergeStrategy).not.toContain('REVIEWER CONSTRAINTS');
      expect(rendered, mergeStrategy).not.toContain('review-read');
      expect(rendered, mergeStrategy).not.toContain('`critic`');
    }
  });

  it('review_level light: one reviewer, no critic/integrator', () => {
    const rendered = render({ reviewLevel: 'light' });
    expect(rendered).toContain('spawn ONE reviewer sub-agent (agents/reviewer.md)');
    expect(rendered).toContain('<reviewer_label> replaced by `reviewer`');
    expect(rendered).not.toContain('`critic`');
    expect(rendered).not.toContain('`integrator`');
    expect(rendered).not.toContain('Self-review');
  });

  it('review_level full: critic and integrator, no single reviewer', () => {
    const rendered = render({ reviewLevel: 'full' });
    expect(rendered).toContain('<reviewer_label> replaced by `critic`');
    expect(rendered).toContain('`integrator` for the other');
    expect(rendered).not.toContain('agents/reviewer.md');
    expect(rendered).not.toContain('Self-review');
  });

  it('states each lifecycle command and rule once', () => {
    for (const mergeStrategy of ['direct', 'pr'] as const) {
      const rendered = render({ mergeStrategy, reviewLevel: 'light' });
      const count = (text: string) => rendered.split(text).length - 1;
      expect(count('orc run-start '), mergeStrategy).toBe(1);
      expect(count('orc run-finish '), mergeStrategy).toBe(1);
      expect(count('orc run-input-request '), mergeStrategy).toBe(1);
      expect(count('orc run-fail --run-id=<run_id> --agent-id=w1 --reason="<explanation>"'), mergeStrategy).toBe(1);
      expect(count('Lease renewal is automatic'), mergeStrategy).toBe(1);
      expect(count('Do not end your turn'), mergeStrategy).toBe(1);
      expect(count('reports itself ready'), mergeStrategy).toBe(1);
    }
    expect(render({ mergeStrategy: 'direct' }).split('orc run-work-complete ').length - 1).toBe(1);
  });

  it('carries no stale state file names, tick wording or frontmatter claim', () => {
    for (const mergeStrategy of ['direct', 'pr'] as const) {
      for (const reviewLevel of ['none', 'light', 'full'] as const) {
        const rendered = render({ mergeStrategy, reviewLevel });
        for (const stale of ['backlog.json', 'claims.json', 'events.db', 'next tick', 'frontmatter', 'runs-active', ' c. ', ' d. ']) {
          expect(rendered, `${mergeStrategy}/${reviewLevel}: ${stale}`).not.toContain(stale);
        }
        expect(rendered).not.toMatch(/\{\{/);
      }
    }
  });

  it('points Claude and Codex at the AGENTS.md they already load, and tells Gemini to read it', () => {
    expect(render({}, 'claude')).toContain('If the repository has an AGENTS.md (loaded into your context with the repo)');
    expect(render({}, 'codex')).toContain('If the repository has an AGENTS.md (loaded into your context with the repo)');
    expect(render({}, 'gemini')).toContain('read AGENTS.md at the worktree root');
  });

  it('is at least 40% smaller than before for a direct-mode, light-review Claude task', () => {
    // 17292 bytes: the v4 bootstrap rendered for this case, which carried every mode and review level.
    const before = 17292;
    const after = Buffer.byteLength(buildSessionBootstrap('worker-01', 'claude', 'worker', 'orc', 'session-id-unset', {
      mergeStrategy: 'direct', reviewLevel: 'light',
    }));
    expect(after).toBeLessThanOrEqual(before * 0.6);
  });
});
