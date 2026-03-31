import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import type { ColorSupportLevel } from 'chalk';
import { buildAgentStatus, buildStatus, formatAgentStatus, formatStatus } from './statusView.ts';
import { colorFormatAgentStatus, colorFormatStatus } from './colorStatus.ts';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

let root: string;
let stateDir: string;
let originalLevel: ColorSupportLevel;

beforeEach(() => {
  root = createTempStateDir('orc-color-status-');
  stateDir = join(root, '.orc-state');
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [
      { agent_id: 'master', provider: 'claude', role: 'master', status: 'running', session_handle: 'pty:master' },
      { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'offline' },
    ],
  }));
  writeFileSync(join(stateDir, 'claims.json'), JSON.stringify({
    version: '1',
    claims: [],
  }));
  writeFileSync(join(stateDir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{
      ref: 'feat',
      title: 'Feature',
      tasks: [
        { ref: 'feat/1', title: 'Task 1', status: 'done', owner: 'orc-1' },
        { ref: 'feat/2', title: 'Task 2', status: 'blocked', owner: 'orc-1' },
      ],
    }],
  }));
  writeFileSync(join(stateDir, 'run-worktrees.json'), JSON.stringify({
    version: '1',
    runs: [],
  }));
  writeFileSync(join(stateDir, 'events.jsonl'), '');
  writeFileSync(join(root, 'orchestrator.config.json'), JSON.stringify({
    worker_pool: { max_workers: 1, provider: 'codex' },
  }));
  originalLevel = chalk.level;
  chalk.level = 1;
});

afterEach(() => {
  chalk.level = originalLevel;
  cleanupTempStateDir(root);
});

describe('colorFormatStatus', () => {
  it('returns ANSI-decorated status text without losing content', () => {
    const status = buildStatus(stateDir);
    const plain = formatStatus(status);
    const colored = colorFormatStatus(status);

    expect(typeof colored).toBe('string');
    expect(colored).toContain('\u001B[');
    expect(colored.replace(/\u001B\[[0-9;]*m/g, '')).toBe(plain);
  });
});

describe('colorFormatAgentStatus', () => {
  it('wraps the plain agent status output', () => {
    const status = buildAgentStatus(stateDir, 'orc-1');
    const plain = formatAgentStatus(status, 'orc-1');
    const colored = colorFormatAgentStatus(status, 'orc-1');

    expect(colored).toContain('\u001B[');
    expect(colored.replace(/\u001B\[[0-9;]*m/g, '')).toBe(plain);
  });
});
