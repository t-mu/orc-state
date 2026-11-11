import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProjectWatchState } from '../../client.ts';
import { nextAttention, type CockpitTabState } from '../cockpitTabs.ts';
import { EXPLORER_SOCKET, attentionQueue, explorerScript, explorerSessionName, tmuxExplorerHost } from './explorer.ts';

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
    expect(EXPLORER_SOCKET).toBe('orc-cockpit2');
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

const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!hasTmux)('tmuxExplorerHost (private tmux server)', () => {
  const socket = `orc-cockpit2-explorer-test-${process.pid}-${Date.now()}`;
  const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' });
  afterAll(() => { tmux('kill-server'); });

  it('starts the explorer in a sized session without a status line, replaces a leftover one, and stops it', async () => {
    const host = tmuxExplorerHost({ tmuxBinary: 'tmux', socket, command: (projectId) => `unset ORC_PROJECT_ID; echo explorer-${projectId}; exec cat` });
    // The server takes its default shell from $SHELL; a non-POSIX one must not break the POSIX script.
    const shell = process.env.SHELL;
    process.env.SHELL = '/bin/false';
    let target;
    try {
      target = await host.start('demo', { cols: 50, rows: 12 });
    } finally {
      if (shell === undefined) delete process.env.SHELL;
      else process.env.SHELL = shell;
    }
    expect(target).toEqual({ socket, session: 'explorer-demo' });
    expect(tmux('display-message', '-p', '-t', '=explorer-demo:', '#{pane_width}x#{pane_height} #{status}').stdout.trim()).toBe('50x12 off');
    const until = Date.now() + 5_000;
    while (!tmux('capture-pane', '-p', '-t', '=explorer-demo:').stdout.includes('explorer-demo')) {
      if (Date.now() > until) throw new Error('the explorer command did not run');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const pane = tmux('display-message', '-p', '-t', '=explorer-demo:', '#{pane_pid}').stdout.trim();
    // A second start (a cockpit that crashed left the first) replaces the session.
    await host.start('demo', { cols: 40, rows: 10 });
    expect(tmux('display-message', '-p', '-t', '=explorer-demo:', '#{pane_pid}').stdout.trim()).not.toBe(pane);
    await host.stop(target);
    expect(tmux('has-session', '-t', '=explorer-demo').status).not.toBe(0);
    // Stopping a session that is gone resolves too.
    await host.stop(target);
  }, 20_000);

  it('kills the session new-session made when a command chained after it fails', async () => {
    // A tmux that names an option no tmux has in place of `status`, so the set-option after new-session fails.
    const dir = mkdtempSync(join(tmpdir(), 'orc-explorer-tmux-'));
    const wrapper = join(dir, 'tmux');
    writeFileSync(wrapper, '#!/bin/sh\nfor a; do shift; [ "$a" = status ] && a=no-such-option; set -- "$@" "$a"; done\nexec tmux "$@"\n');
    chmodSync(wrapper, 0o755);
    try {
      const host = tmuxExplorerHost({ tmuxBinary: wrapper, socket, command: () => 'exec cat' });
      await expect(host.start('broken', { cols: 40, rows: 10 })).rejects.toThrow(/no-such-option/);
      expect(tmux('has-session', '-t', '=explorer-broken').status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
