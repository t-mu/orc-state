import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIEF_MAX, handleHook, runHook, taskLabelsPath, toolBrief } from './orc-hook.ts';

const TS = '2026-10-31T12:00:00.000Z';
const NOW = new Date(TS);
const SCRIPT = fileURLToPath(new URL('./orc-hook.ts', import.meta.url));

describe('toolBrief', () => {
  const cwd = '/repo/wt';
  it.each([
    ['Edit', { file_path: '/repo/wt/lib/a.ts', old_string: 'secret', new_string: 'x' }, 'lib/a.ts'],
    ['Write', { file_path: '/repo/wt/b.md', content: 'TOKEN=abc' }, 'b.md'],
    ['Read', { file_path: '/etc/hosts' }, '/etc/hosts'],
    ['Read', { file_path: '/repo/other/c.ts' }, '/repo/other/c.ts'],
    ['NotebookEdit', { notebook_path: '/repo/wt/n.ipynb', new_source: 'x' }, 'n.ipynb'],
    ['Bash', { command: 'npm   test\n  -- --run' }, 'npm test -- --run'],
    ['Grep', { pattern: 'foo.*bar', path: '/repo' }, 'foo.*bar'],
    ['Glob', { pattern: '**/*.ts' }, '**/*.ts'],
    ['Agent', { description: 'Review diff', prompt: 'long prompt', subagent_type: 'critic' }, 'Review diff'],
    ['Task', { subagent_type: 'critic', prompt: 'long prompt' }, 'critic'],
    ['WebFetch', { url: 'https://code.claude.com/docs/en/hooks?token=s3cret', prompt: 'x' }, 'code.claude.com'],
    ['WebSearch', { query: 'claude code hooks' }, 'claude code hooks'],
    ['mcp__orc__status', { secret: 'x' }, ''],
  ])('%s → %j', (tool, input, expected) => {
    expect(toolBrief(tool, input, cwd)).toBe(expected);
  });

  it('caps Bash at 60 chars and other briefs at 80', () => {
    const bash = toolBrief('Bash', { command: 'x'.repeat(500) }, cwd);
    expect(bash.length).toBe(60);
    const grep = toolBrief('Grep', { pattern: 'y'.repeat(500) }, cwd);
    expect(grep.length).toBe(BRIEF_MAX);
  });
});

describe('handleHook', () => {
  it('permission: records only permission_prompt notifications', () => {
    expect(handleHook('permission', { notification_type: 'permission_prompt', message: 'Allow?' }, {}, TS).record)
      .toEqual({ type: 'permission', message: 'Allow?', ts: TS });
    expect(handleHook('permission', { notification_type: 'idle_prompt', message: 'x' }, {}, TS).record).toBeNull();
  });

  it('tool: emits tool + brief, never the full input or response', () => {
    const { record } = handleHook('tool', {
      tool_name: 'Bash', cwd: '/w', tool_input: { command: 'echo hi' }, tool_response: { stdout: 'SECRET' },
    }, {}, TS);
    expect(record).toEqual({ type: 'tool', tool: 'Bash', brief: 'echo hi', ts: TS });
    expect(handleHook('tool', { tool_input: {} }, {}, TS).record).toBeNull();
  });

  it('tool: remembers the label of a created task by the id in its response', () => {
    const { labels } = handleHook('tool', {
      tool_name: 'TaskCreate', tool_input: { subject: 'Write tests', activeForm: 'Writing tests' },
      tool_response: { task: { id: '7', subject: 'Write tests' } },
    }, { 1: 'Old' }, TS);
    expect(labels).toEqual({ 1: 'Old', 7: 'Writing tests' });
  });

  describe('todo: TodoWrite', () => {
    const write = (todos: unknown) => handleHook('todo', { tool_name: 'TodoWrite', tool_input: { todos } }, {}, TS).record;

    it('labels with the in_progress item activeForm', () => {
      expect(write([
        { content: 'Explore', status: 'completed', activeForm: 'Exploring' },
        { content: 'Implement', status: 'in_progress', activeForm: 'Implementing' },
        { content: 'Review', status: 'pending', activeForm: 'Reviewing' },
      ])).toEqual({ type: 'activity', label: 'Implementing', source: 'todo', ts: TS });
    });

    it('falls back to content without activeForm', () => {
      expect(write([{ content: 'Implement', status: 'in_progress' }])).toMatchObject({ label: 'Implement' });
    });

    it('emits an empty label when nothing is in progress', () => {
      expect(write([{ content: 'Done', status: 'completed', activeForm: 'Doing' }])).toMatchObject({ label: '' });
      expect(write('not-an-array')).toMatchObject({ label: '' });
    });
  });

  describe('todo: TaskCreate / TaskUpdate', () => {
    const task = (tool: string, input: Record<string, unknown>, labels: Record<string, string> = {}) =>
      handleHook('todo', { tool_name: tool, tool_input: input }, labels, TS);

    it('labels an in_progress task with activeForm, falling back to subject', () => {
      expect(task('TaskCreate', { subject: 'Fix bug', activeForm: 'Fixing bug', status: 'in_progress' }).record)
        .toEqual({ type: 'activity', label: 'Fixing bug', source: 'todo', ts: TS });
      expect(task('TaskUpdate', { taskId: '3', subject: 'Fix bug', status: 'in_progress' }).record)
        .toMatchObject({ label: 'Fix bug' });
    });

    it('resolves a status-only update from the remembered label', () => {
      const result = task('TaskUpdate', { taskId: '3', status: 'in_progress' }, { 3: 'Fixing bug' });
      expect(result.record).toMatchObject({ label: 'Fixing bug' });
      expect(result.labels).toBeUndefined();
    });

    it('remembers labels given on an update and emits nothing without in_progress', () => {
      const result = task('TaskUpdate', { taskId: '4', activeForm: 'Reviewing' });
      expect(result.record).toBeNull();
      expect(result.labels).toEqual({ 4: 'Reviewing' });
    });

    it('emits nothing for an in_progress update with no known label', () => {
      expect(task('TaskUpdate', { taskId: '9', status: 'in_progress' }).record).toBeNull();
    });

    it('clears the label when the item completes', () => {
      expect(task('TaskUpdate', { taskId: '3', status: 'completed' }, { 3: 'Fixing bug' }).record)
        .toEqual({ type: 'activity', label: '', source: 'todo', ts: TS });
    });
  });

  it('ignores unknown kinds', () => {
    expect(handleHook('bogus', { tool_name: 'Bash' }, {}, TS).record).toBeNull();
  });
});

describe('runHook / script', () => {
  let dir: string;
  let events: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orc-hook-'));
    events = join(dir, 'w1.ndjson');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const lines = () => (existsSync(events) ? readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown) : []);

  it('keeps task labels across invocations in the sidecar file', () => {
    runHook('tool', events, JSON.stringify({
      tool_name: 'TaskCreate', tool_input: { subject: 'Ship it' }, tool_response: { task: { id: '1' } },
    }), NOW);
    runHook('todo', events, JSON.stringify({ tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'in_progress' } }), NOW);
    runHook('todo', events, JSON.stringify({ tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'completed' } }), NOW);
    expect(JSON.parse(readFileSync(taskLabelsPath(events), 'utf8'))).toEqual({ 1: 'Ship it' });
    expect(lines()).toEqual([
      { type: 'tool', tool: 'TaskCreate', brief: '', ts: TS },
      { type: 'activity', label: 'Ship it', source: 'todo', ts: TS },
      { type: 'activity', label: '', source: 'todo', ts: TS },
    ]);
  });

  it('drops malformed stdin and an unwritable events file without throwing', () => {
    expect(() => runHook('tool', events, 'not json{', NOW)).not.toThrow();
    expect(() => runHook('tool', events, '', NOW)).not.toThrow();
    expect(() => runHook('tool', events, '[1,2]', NOW)).not.toThrow();
    expect(() => runHook('tool', join(dir, 'missing', 'x.ndjson'), JSON.stringify({ tool_name: 'Bash' }), NOW)).not.toThrow();
    expect(lines()).toEqual([]);
  });

  it('runs as a command: appends one line and exits 0, also on malformed stdin', () => {
    const ok = spawnSync(process.execPath, [SCRIPT, 'tool', events], {
      input: JSON.stringify({ tool_name: 'Grep', tool_input: { pattern: 'TODO' } }), encoding: 'utf8',
    });
    expect(ok.status).toBe(0);
    const bad = spawnSync(process.execPath, [SCRIPT, 'todo', events], { input: '{{{', encoding: 'utf8' });
    expect(bad.status).toBe(0);
    expect(bad.stderr).toBe('');
    expect(lines()).toEqual([{ type: 'tool', tool: 'Grep', brief: 'TODO', ts: expect.any(String) }]);
  });
});
