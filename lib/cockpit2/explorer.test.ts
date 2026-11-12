import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ProjectWatchState } from '../../client.ts';
import { nextAttention, type CockpitTabState } from '../cockpitTabs.ts';
import { EXPLORER_SOCKET, SHELL_SCRIPT, attentionQueue, explorerScript, explorerSessionName, isShellTab, nextShellTab, shellSessionName } from './explorer.ts';

type Kind = 'question' | 'permission_prompt' | 'stalled' | 'no_progress';

function watched(id: string, agents: { agent_id: string; kind: Kind; role?: string }[], running = true): ProjectWatchState {
  return {
    project: { id, name: id, target_repo_root: `/repo/${id}`, state_dir: `/state/${id}`, repo_present: true, control_socket: null, coordinator_running: running },
    connection: running ? 'running' : 'stopped',
    error: null,
    status: {
      worker_capacity: {
        configured_slots: 2, used_slots: agents.length,
        slots: agents.map(({ agent_id, kind, role = 'worker' }) => ({ agent_id, role, attention: { kind, detail: null } })),
      },
    } as never,
    cursor: null,
  };
}

describe('explorerSessionName and explorerScript', () => {
  it('names one session per project, without the characters tmux reserves in targets', () => {
    expect(explorerSessionName('demo')).toBe('explorer-demo');
    expect(explorerSessionName('a.b:c/d')).toBe('explorer-a_b_c_d');
    expect(EXPLORER_SOCKET).toBe('orc-explorer');
  });

  it('keeps a failing explorer\'s error on screen and lets a clean exit end the session', () => {
    // A failing explorer's line stays until a key arrives; then the script ends.
    const fail = spawnSync('/bin/sh', ['-c', explorerScript('(exit 3)')], { encoding: 'utf8', input: 'q', timeout: 5_000 });
    expect(fail.stdout).toContain('[the task explorer exited with status 3; any key closes this tab]');
    expect(fail.signal).toBeNull();
    const ok = spawnSync('/bin/sh', ['-c', explorerScript('echo fine')], { encoding: 'utf8', timeout: 5_000 });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe('fine\n');
  });
});

describe('shell tabs', () => {
  it('tells shell tab ids from agent ids and gives the first free number', () => {
    expect(isShellTab('shell:1')).toBe(true);
    expect(isShellTab('shell-1')).toBe(false);
    expect(isShellTab('w1')).toBe(false);
    expect(isShellTab(null)).toBe(false);
    expect(nextShellTab([])).toBe('shell:1');
    expect(nextShellTab(['w1', 'shell:1', 'shell:3'])).toBe('shell:2');
    expect(nextShellTab(['shell:1', 'shell:2'])).toBe('shell:3');
  });

  it('names a shell tab\'s session per project and number, without tmux\'s target characters', () => {
    expect(shellSessionName('demo', 'shell:1')).toBe('shell-demo-1');
    expect(shellSessionName('a.b:c', 'shell:12')).toBe('shell-a_b_c-12');
  });

  it('runs the login shell with no ORC_* variable left', () => {
    const run = spawnSync('/bin/sh', ['-c', SHELL_SCRIPT], {
      encoding: 'utf8', timeout: 5_000, input: 'env\n',
      env: { PATH: process.env.PATH, SHELL: '/bin/sh', ORC_SECRET: 'x', ORC_OTHER_2: 'y', KEEP: 'z' },
    });
    expect(run.stdout).toContain('KEEP=z');
    expect(run.stdout).not.toContain('ORC_');
  });
});

describe('attentionQueue', () => {
  const state: CockpitTabState = {
    activeProject: 'b',
    projects: [{ projectId: 'b', tabs: [], active: null }, { projectId: 'a', tabs: ['a1'], active: 'a1' }],
  };
  const projects = [
    watched('a', [{ agent_id: 'a1', kind: 'question' }, { agent_id: 'a2', kind: 'permission_prompt' }]),
    watched('b', [{ agent_id: 'master', kind: 'question', role: 'master' }]),
    watched('c', [{ agent_id: 'c1', kind: 'stalled' }]),
    watched('down', [{ agent_id: 'd1', kind: 'permission_prompt' }], false),
  ];

  it('lists the cockpit\'s projects first, then the other watched ones, permission prompts first, skipping stopped projects', () => {
    expect(attentionQueue(state, projects)).toEqual([
      { projectId: 'b', agentId: 'master', master: true },
      { projectId: 'a', agentId: 'a2' },
      { projectId: 'a', agentId: 'a1' },
      { projectId: 'c', agentId: 'c1' },
    ]);
    expect(attentionQueue(state, [])).toEqual([]);
  });

  it('drives nextAttention across projects: from the shown agent to the next, opening tabs and projects as needed, wrapping around', () => {
    const waiting = attentionQueue(state, projects);
    // b's master is shown: next is a2 in project a, opened in a new tab.
    let step = nextAttention(state, waiting);
    expect(step.state.activeProject).toBe('a');
    expect(step.state.projects.find((project) => project.projectId === 'a')).toEqual({ projectId: 'a', tabs: ['a1', 'a2'], active: 'a2' });
    step = nextAttention(step.state, waiting);
    expect(step.state.projects.find((project) => project.projectId === 'a')?.active).toBe('a1');
    // c is not in the cockpit yet: it is added with the agent's tab.
    step = nextAttention(step.state, waiting);
    expect(step.state.activeProject).toBe('c');
    expect(step.state.projects.at(-1)).toEqual({ projectId: 'c', tabs: ['c1'], active: 'c1' });
    // Wraps around to b's master tab.
    step = nextAttention(step.state, waiting);
    expect(step.state.activeProject).toBe('b');
    expect(step.state.projects[0].active).toBeNull();
  });
});
