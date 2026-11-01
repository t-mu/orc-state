import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { dispatchHookEvents } from './hookEventBus.ts';

const TS = '2026-10-31T12:00:00.000Z';

describe('dispatchHookEvents', () => {
  it('routes permission events to permission, tool and activity events to activity', () => {
    const out = dispatchHookEvents([
      { type: 'permission', message: 'Allow Bash?', ts: TS },
      { type: 'tool', tool: 'Edit', brief: 'lib/a.ts', ts: TS },
      { type: 'activity', label: ' Write tests ', source: 'todo', ts: TS },
      { type: 'activity', label: 'Thinking about X', ts: TS },
    ]);
    expect(out.permission).toEqual([{ type: 'permission', message: 'Allow Bash?', ts: TS }]);
    expect(out.activity).toEqual([
      { type: 'tool', tool: 'Edit', brief: 'lib/a.ts', ts: TS },
      { type: 'activity', label: 'Write tests', source: 'todo', ts: TS },
      { type: 'activity', label: 'Thinking about X', source: 'note', ts: TS },
    ]);
  });

  it('passes a tool event\'s sub-agent type through and drops an empty one', () => {
    const out = dispatchHookEvents([
      { type: 'tool', tool: 'Agent', brief: 'Check diff', subagent_type: 'critic', ts: TS },
      { type: 'tool', tool: 'Agent', brief: 'Explore', subagent_type: '', ts: TS },
    ]);
    expect(out.activity).toEqual([
      { type: 'tool', tool: 'Agent', brief: 'Check diff', subagent_type: 'critic', ts: TS },
      { type: 'tool', tool: 'Agent', brief: 'Explore', ts: TS },
    ]);
  });

  it('routes tool_start events to activity and carries tool ids, skipping a tool_start without a tool', () => {
    const out = dispatchHookEvents([
      { type: 'tool_start', tool: 'Bash', id: 'toolu_1', ts: TS },
      { type: 'tool_start', tool: 'Read', id: '', ts: TS },
      { type: 'tool_start', ts: TS },
      { type: 'tool', tool: 'Bash', brief: 'npm test', id: 'toolu_1', ts: TS },
    ]);
    expect(out.activity).toEqual([
      { type: 'tool_start', tool: 'Bash', id: 'toolu_1', ts: TS },
      { type: 'tool_start', tool: 'Read', ts: TS },
      { type: 'tool', tool: 'Bash', brief: 'npm test', id: 'toolu_1', ts: TS },
    ]);
  });

  it('keeps permission events lenient, as the Notification hook has always been read', () => {
    expect(dispatchHookEvents([{ type: 'permission' }]).permission).toEqual([{ type: 'permission', message: '', ts: '' }]);
  });

  it('ignores unknown types and skips malformed tool/activity records', () => {
    const out = dispatchHookEvents([
      { type: 'session_start', ts: TS },
      { message: 'no type' },
      { type: 'tool', brief: 'missing tool', ts: TS },
      { type: 'tool', tool: 'Bash', ts: 'not-a-date' },
      { type: 'activity', label: '   ', ts: TS },
      { type: 'activity', label: 'no ts' },
    ]);
    expect(out).toEqual({ permission: [], activity: [] });
  });

  it('keeps an empty todo label as a clear, but not an empty note', () => {
    const out = dispatchHookEvents([
      { type: 'activity', label: '', source: 'todo', ts: TS },
      { type: 'activity', label: '', source: 'note', ts: TS },
    ]);
    expect(out.activity).toEqual([{ type: 'activity', label: '', source: 'todo', ts: TS }]);
  });
});

describe('drainHookEvents', () => {
  let stateDir: string;

  beforeEach(() => {
    vi.resetModules();
    stateDir = createTempStateDir('hook-bus-test-');
    vi.stubEnv('ORC_STATE_DIR', stateDir);
    mkdirSync(join(stateDir, 'pty-hook-events'), { recursive: true });
  });

  afterEach(() => {
    cleanupTempStateDir(stateDir);
    vi.unstubAllEnvs();
  });

  it('consumes the agent hook file once and dispatches every line, skipping malformed ones', async () => {
    const { drainHookEvents } = await import('./hookEventBus.ts');
    const { hookEventPath } = await import('./paths.ts');
    const file = hookEventPath('agent-1');
    writeFileSync(file, [
      JSON.stringify({ type: 'permission', message: 'Allow?', ts: TS }),
      'NOT-JSON',
      '42',
      JSON.stringify({ type: 'tool', tool: 'Read', brief: 'README.md', ts: TS }),
    ].join('\n') + '\n');

    const first = drainHookEvents('agent-1');
    expect(first.permission).toHaveLength(1);
    expect(first.activity).toEqual([{ type: 'tool', tool: 'Read', brief: 'README.md', ts: TS }]);
    expect(existsSync(file)).toBe(false);
    expect(drainHookEvents('agent-1')).toEqual({ permission: [], activity: [] });
  });
});
