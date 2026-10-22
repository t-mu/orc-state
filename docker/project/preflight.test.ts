import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, 'preflight.sh');
let project: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'orc-project-preflight-'));
  execFileSync('git', ['init', project], { stdio: 'ignore' });
  const bin = join(project, 'bin');
  mkdirSync(bin);
  mkdirSync(join(project, 'home'));
  mkdirSync(join(project, '.orc-state'));
  writeFileSync(join(bin, 'orc'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: join(project, 'home'),
    ORC_PROJECT_DIR: project,
    ORC_STATE_DIR: join(project, '.orc-state'),
    ORC_WORKER_PROVIDER: 'claude',
    ORC_MASTER_PROVIDER: 'claude',
  };
});

afterEach(() => rmSync(project, { recursive: true, force: true }));

describe('project runtime preflight', () => {
  it('accepts writable project and scoped state with authenticated provider', () => {
    const result = spawnSync('bash', [script], { env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Project preflight passed');
  });

  it('stops startup when the provider login is missing', () => {
    writeFileSync(join(project, 'bin', 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const result = spawnSync('bash', [script], { env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Provider login is missing for claude');
  });
});
