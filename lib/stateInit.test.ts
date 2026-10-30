import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStateInitialized } from './stateInit.ts';
import { createTempStateDir, cleanupTempStateDir, seedProjectTasks } from '../test-fixtures/stateHelpers.ts';

let tmpDir: string;

afterEach(() => {
  cleanupTempStateDir(tmpDir);
});

describe('ensureStateInitialized', () => {
  it('creates all state files in a fresh directory', () => {
    tmpDir = createTempStateDir('orc-state-init-test-');
    const stateDir = join(tmpDir, 'new-dir');

    ensureStateInitialized(stateDir);

    expect(existsSync(join(stateDir, 'runtime.db'))).toBe(true);
    expect(existsSync(join(stateDir, 'backlog.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'agents.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'claims.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'events.db'))).toBe(true);
  });

  it('writes valid default JSON content', () => {
    tmpDir = createTempStateDir('orc-state-init-test-');
    const stateDir = join(tmpDir, 'state');

    ensureStateInitialized(stateDir);

    // backlog.json is the (empty) task store's projection, not a hand-built default.
    expect(JSON.parse(readFileSync(join(stateDir, 'backlog.json'), 'utf8'))).toEqual({ version: '1', features: [] });

    const agents = JSON.parse(readFileSync(join(stateDir, 'agents.json'), 'utf8')) as {
      version: string;
      agents: unknown[];
    };
    expect(agents.version).toBe('1');
    expect(agents.agents).toEqual([]);

    const claims = JSON.parse(readFileSync(join(stateDir, 'claims.json'), 'utf8')) as {
      version: string;
      claims: unknown[];
    };
    expect(claims.version).toBe('1');
    expect(claims.claims).toEqual([]);
  });

  it('is idempotent — does not overwrite an existing project backlog projection on second call', () => {
    tmpDir = createTempStateDir('orc-state-init-test-');
    const stateDir = join(tmpDir, 'state');

    ensureStateInitialized(stateDir);

    // A registered project's tasks live in its store; backlog.json is their projection.
    seedProjectTasks(stateDir, [{ ref: 'custom/task-1', title: 'Custom task' }]);

    // Second call (e.g. start-session on an existing project) must not clobber the projection
    ensureStateInitialized(stateDir);

    const backlog = JSON.parse(readFileSync(join(stateDir, 'backlog.json'), 'utf8')) as {
      features: { ref: string; tasks: { ref: string }[] }[];
    };
    expect(backlog.features.map((feature) => feature.ref)).toEqual(['custom']);
    expect(backlog.features[0].tasks.map((task) => task.ref)).toEqual(['custom/task-1']);
  });
});
