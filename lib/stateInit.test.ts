import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureStateInitialized } from './stateInit.ts';

let tmpDir: string;

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('ensureStateInitialized', () => {
  it('creates all state files in a fresh directory', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orc-state-init-test-'));
    const stateDir = join(tmpDir, 'new-dir');

    ensureStateInitialized(stateDir);

    expect(existsSync(join(stateDir, 'backlog.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'agents.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'claims.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'events.db'))).toBe(true);
  });

  it('writes valid default JSON content', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orc-state-init-test-'));
    const stateDir = join(tmpDir, 'state');

    ensureStateInitialized(stateDir);

    const backlog = JSON.parse(readFileSync(join(stateDir, 'backlog.json'), 'utf8')) as {
      version: string;
      features: { ref: string; title: string; tasks: unknown[] }[];
    };
    expect(backlog.version).toBe('1');
    expect(backlog.features).toHaveLength(1);
    expect(backlog.features[0].ref).toBe('project');
    expect(backlog.features[0].title).toBe('Project');
    expect(backlog.features[0].tasks).toEqual([]);

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

  it('is idempotent — does not overwrite existing files on second call', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orc-state-init-test-'));
    const stateDir = join(tmpDir, 'state');

    ensureStateInitialized(stateDir);

    // Overwrite backlog with custom content to simulate an already-initialised repo
    writeFileSync(
      join(stateDir, 'backlog.json'),
      JSON.stringify({ version: '1', features: [{ ref: 'custom', title: 'Custom', tasks: [] }] }, null, 2) + '\n',
      'utf8',
    );

    // Second call must not clobber the custom content
    ensureStateInitialized(stateDir);

    const backlog = JSON.parse(readFileSync(join(stateDir, 'backlog.json'), 'utf8')) as {
      features: { ref: string }[];
    };
    expect(backlog.features[0].ref).toBe('custom');
  });
});
