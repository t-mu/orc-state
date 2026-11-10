import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import React, { act } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import type { ProjectConnectionState } from '../../client.ts';
import { TaskExplorer, type TaskExplorerProps } from './TaskExplorer.tsx';
import type { ProjectTaskSummary, ProjectTaskView, TaskRevisionSummary, TuiTaskClient } from './taskList.ts';

const DOWN = '\u001B[B';
const ENTER = '\r';
const ESC = '\u001B';

function task(ref: string, status: string, extra: Partial<ProjectTaskView> = {}): ProjectTaskView {
  return {
    ref, title: `Title of ${ref}`, status, feature_ref: ref.split('/')[0], content_hash: 'h', spec_revision: 1,
    body_markdown: `# ${ref}\n\nSpec body.`, ...extra,
  } as ProjectTaskView;
}

/**
 * A client with only the read routes, recording each call. Any other member
 * (a write route) throws, so a write attempt fails the test.
 */
function fakeClient(byDir: Record<string, ProjectTaskView[]>, revisions: Record<string, TaskRevisionSummary[]> = {}) {
  const calls: string[] = [];
  const create = (stateDir: string): TuiTaskClient => {
    const tasks = byDir[stateDir] ?? [];
    const client = {
      listTasks: (opts?: { fields?: string }) => {
        calls.push(`list ${stateDir} ${opts?.fields ?? ''}`);
        return Promise.resolve({ tasks: tasks.map(({ body_markdown: _, ...summary }) => summary as ProjectTaskSummary) });
      },
      getTask: (ref: string) => {
        calls.push(`get ${stateDir} ${ref}`);
        const found = tasks.find(t => t.ref === ref);
        return found ? Promise.resolve({ task: found }) : Promise.reject(new Error(`not found: ${ref}`));
      },
      taskRevisions: (ref: string) => {
        calls.push(`revisions ${stateDir} ${ref}`);
        return Promise.resolve({ revisions: revisions[ref] ?? [] });
      },
    };
    return new Proxy(client, {
      get(target, prop) {
        if (typeof prop === 'string' && !(prop in target) && prop !== 'then') throw new Error(`task explorer called ${prop}`);
        return Reflect.get(target, prop) as unknown;
      },
    }) as unknown as TuiTaskClient;
  };
  return { create, calls };
}

type ExplorerProject = TaskExplorerProps['projects'][number];

function proj(id: string, connection: ProjectConnectionState = 'running', error: string | null = null): ExplorerProject {
  return { project_id: id, name: id, state_dir: `/state/${id}`, connection, error };
}

function plain(frame: string | undefined): string {
  return stripVTControlCharacters(frame ?? '').trimEnd();
}

/** Run `action`, then let pending promises and the resulting renders settle. */
async function settle(action: () => void = () => {}): Promise<void> {
  await act(async () => {
    action();
    await new Promise(resolve => setImmediate(resolve));
  });
}

afterEach(() => {
  cleanup();
});

function renderExplorer(projects: ExplorerProject[], create: TaskExplorerProps['createClient'], rows?: number) {
  return render(<TaskExplorer projects={projects} initialProjectId={projects[0]?.project_id ?? null} createClient={create} rows={rows} columns={60} />);
}

describe('TaskExplorer', () => {
  it('lists every task of the selected project with its status, through the summary list route', async () => {
    const client = fakeClient({ '/state/alpha': [task('alpha/one', 'todo'), task('alpha/two', 'done'), task('beta/three', 'blocked')] });
    const app = renderExplorer([proj('alpha')], client.create);
    await settle();
    const frame = plain(app.lastFrame());

    expect(frame).toContain('Tasks alpha');
    expect(frame).toContain('status: all · feature: all · 3/3');
    expect(frame).toMatch(/› todo\s+alpha\/one/);
    expect(frame).toMatch(/done\s+alpha\/two/);
    expect(frame).toMatch(/blocked\s+beta\/three/);
    expect(client.calls).toEqual(['list /state/alpha summary']);
  });

  it('filters by status with s and by feature with f', async () => {
    const client = fakeClient({ '/state/alpha': [task('alpha/one', 'todo'), task('alpha/two', 'done'), task('beta/three', 'todo')] });
    const app = renderExplorer([proj('alpha')], client.create);
    await settle();

    await settle(() => app.stdin.write('s'));
    let frame = plain(app.lastFrame());
    expect(frame).toContain('status: todo · feature: all · 2/3');
    expect(frame).toContain('alpha/one');
    expect(frame).not.toContain('alpha/two');

    await settle(() => app.stdin.write('f'));
    frame = plain(app.lastFrame());
    expect(frame).toContain('status: todo · feature: alpha · 1/3');
    expect(frame).toContain('alpha/one');
    expect(frame).not.toContain('beta/three');

    await settle(() => app.stdin.write('s'));
    await settle(() => app.stdin.write('f'));
    frame = plain(app.lastFrame());
    expect(frame).toContain('status: done · feature: beta · 0/3');
    expect(frame).toContain('(no tasks match the filter)');
  });

  it('moves the selection and shows the selected task\'s title, priority and dependencies', async () => {
    const client = fakeClient({ '/state/alpha': [
      task('alpha/one', 'todo'),
      task('alpha/two', 'todo', { priority: 'high', depends_on: ['alpha/one'] }),
    ] });
    const app = renderExplorer([proj('alpha')], client.create);
    await settle();
    await settle(() => app.stdin.write(DOWN));
    const frame = plain(app.lastFrame());

    expect(frame).toMatch(/› todo alpha\/two/);
    expect(frame).toContain('Title of alpha/two');
    expect(frame).toContain('priority: high · depends on: alpha/one');
  });

  it('opens a task to its spec and revision list, scrolls a long spec, and goes back with Esc', async () => {
    const body = Array.from({ length: 40 }, (_, i) => `spec line ${i + 1}`).join('\n');
    const client = fakeClient(
      { '/state/alpha': [task('alpha/one', 'todo', { body_markdown: body, spec_revision: 2 })] },
      { 'alpha/one': [
        { taskRef: 'alpha/one', revision: 1, contentHash: 'a', title: 'Draft', metadata: {}, createdAt: '2026-11-01T00:00:00Z' },
        { taskRef: 'alpha/one', revision: 2, contentHash: 'b', title: 'Title of alpha/one', metadata: {}, createdAt: '2026-11-02T00:00:00Z' },
      ] },
    );
    const app = renderExplorer([proj('alpha')], client.create, 20);
    await settle();
    await settle(() => app.stdin.write(ENTER));
    let frame = plain(app.lastFrame());

    expect(frame).toContain('‹ alpha/one');
    expect(frame).toContain('Revisions (2)');
    expect(frame).toContain('r1  2026-11-01T00:00:00Z  Draft');
    expect(frame).toContain('Spec (revision 2)');
    expect(frame).toContain('spec line 1');
    expect(frame).not.toContain('spec line 40');
    expect(frame.split('\n').length).toBeLessThan(20);
    expect(client.calls).toContain('get /state/alpha alpha/one');
    expect(client.calls).toContain('revisions /state/alpha alpha/one');

    await settle(() => app.stdin.write('G'));
    frame = plain(app.lastFrame());
    expect(frame).toContain('spec line 40');
    expect(frame).not.toContain('Revisions (2)');

    await settle(() => app.stdin.write('g'));
    await settle(() => app.stdin.write('j'));
    frame = plain(app.lastFrame());
    expect(frame).not.toContain('title: Title of alpha/one');
    expect(frame).toMatch(/2-\d+\/\d+/);

    await settle(() => app.stdin.write(ESC));
    frame = plain(app.lastFrame());
    expect(frame).toContain('Tasks alpha');
    expect(frame).toMatch(/› todo alpha\/one/);
  });

  it('truncates long refs and titles to the terminal width', async () => {
    const long = 'feature-with-a-long-name/a-task-slug-that-goes-on-and-on-for-quite-a-while';
    const client = fakeClient({ '/state/alpha': [task(long, 'todo', { title: 'A title that is far too long to fit on one line '.repeat(3) })] });
    const app = renderExplorer([proj('alpha')], client.create);
    await settle();
    // ink-testing-library renders 100 columns.
    for (const line of plain(app.lastFrame()).split('\n')) expect(line.length).toBeLessThanOrEqual(100);
    await settle(() => app.stdin.write(ENTER));
    for (const line of plain(app.lastFrame()).split('\n')) expect(line.length).toBeLessThanOrEqual(100);
  });

  it('says so for a project with no tasks', async () => {
    const client = fakeClient({ '/state/empty': [] });
    const app = renderExplorer([proj('empty')], client.create);
    await settle();
    expect(plain(app.lastFrame())).toContain('(no tasks in this project)');
  });

  it('says the coordinator is not running for a stopped project, without calling it, and switches projects with ←/→', async () => {
    const client = fakeClient({ '/state/live': [task('live/one', 'todo')] });
    const app = renderExplorer([proj('idle', 'stopped'), proj('live'), proj('old', 'incompatible', 'protocol v9 not supported')], client.create);
    await settle();
    let frame = plain(app.lastFrame());
    expect(frame).toContain('Tasks idle (1/3 ←→)');
    expect(frame).toContain('coordinator not running: start it to browse this project\'s tasks');
    expect(client.calls).toEqual([]);

    await settle(() => app.stdin.write('l'));
    frame = plain(app.lastFrame());
    expect(frame).toContain('Tasks live (2/3 ←→)');
    expect(frame).toContain('live/one');

    await settle(() => app.stdin.write('\u001B[C'));
    expect(plain(app.lastFrame())).toContain('incompatible: protocol v9 not supported');
  });

  it('shows a failed list call as an error', async () => {
    const create = (): TuiTaskClient => ({
      listTasks: () => Promise.reject(new Error('Control daemon is not running')),
      getTask: () => Promise.reject(new Error('unused')),
      taskRevisions: () => Promise.reject(new Error('unused')),
    }) as unknown as TuiTaskClient;
    const app = renderExplorer([proj('alpha')], create);
    await settle();
    expect(plain(app.lastFrame())).toContain('cannot list tasks: Control daemon is not running');
  });
});

describe('TaskExplorer close', () => {
  it('Esc or q in the list calls onClose', async () => {
    const client = fakeClient({ '/state/alpha': [task('alpha/one', 'todo')] });
    for (const key of [ESC, 'q']) {
      let closed = 0;
      const app = render(<TaskExplorer projects={[proj('alpha')]} initialProjectId="alpha" createClient={client.create} rows={undefined} columns={60} onClose={() => { closed += 1; }} />);
      await settle();
      await settle(() => app.stdin.write(key));
      expect(closed).toBe(1);
      app.unmount();
    }
  });

  it('Esc in the spec view goes back to the list rather than closing', async () => {
    const client = fakeClient({ '/state/alpha': [task('alpha/one', 'todo')] });
    let closed = 0;
    const app = render(<TaskExplorer projects={[proj('alpha')]} initialProjectId="alpha" createClient={client.create} rows={undefined} columns={60} onClose={() => { closed += 1; }} />);
    await settle();
    await settle(() => app.stdin.write(ENTER));
    await settle(() => app.stdin.write(ESC));
    expect(closed).toBe(0);
    expect(plain(app.lastFrame())).toContain('Tasks alpha');
  });
});

describe('task explorer is read-only', () => {
  it('its client type has the read routes only', () => {
    expectTypeOf<keyof TuiTaskClient>().toEqualTypeOf<'listTasks' | 'getTask' | 'taskRevisions'>();
  });

  it('its modules call no mutating ControlClient method', () => {
    const writes = /\b(sendMessage|consumeMessage|submitCommand|acknowledge|lifecycle|createTask|reviseTask|importTasks|importPlans|acquireTerminal|renewTerminal|releaseTerminal|inputTerminal|resizeTerminal)\s*\(/;
    for (const file of ['TaskExplorer.tsx', 'taskList.ts']) {
      const source = readFileSync(join(import.meta.dirname, file), 'utf8');
      expect(source, file).not.toMatch(writes);
    }
  });
});
