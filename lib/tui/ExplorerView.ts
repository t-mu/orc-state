/**
 * lib/tui/ExplorerView.ts
 *
 * The task explorer as the cockpit's explorer pane runs it: TaskExplorer fed
 * by a project watcher, so the project list follows the watcher and the size
 * follows the terminal. A `.ts` file (not JSX) so orc runs it from source, as
 * cli/watch.ts does.
 */
import { render, useStdout } from 'ink';
import { createElement, useEffect, useMemo, useState } from 'react';
import { ControlClient, type ProjectWatchState, type ProjectWatcher } from '../../client.ts';
import { buildProjectViews, type TuiWatchSource } from './status.ts';
import { TaskExplorer } from './TaskExplorer.tsx';

interface ExplorerHostProps {
  source: TuiWatchSource;
  projectId: string;
  onClose: () => void;
}

/** The task explorer fed by a project watcher: the projects follow the watcher's updates, the size follows the terminal. */
function ExplorerHost({ source, projectId, onClose }: ExplorerHostProps) {
  const { stdout } = useStdout();
  const [states, setStates] = useState<ProjectWatchState[]>(() => source.projects());
  const [size, setSize] = useState(() => ({ rows: stdout.rows, columns: stdout.columns }));
  useEffect(() => source.onUpdate(() => setStates(source.projects())), [source]);
  useEffect(() => {
    const onResize = () => setSize({ rows: stdout.rows, columns: stdout.columns });
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);
  const projects = useMemo(() => buildProjectViews(states), [states]);
  return createElement(TaskExplorer, {
    projects,
    initialProjectId: projectId,
    createClient: (stateDir: string) => new ControlClient(stateDir),
    rows: size.rows,
    columns: size.columns,
    onClose,
  });
}

/** Runs the task explorer for `projectId` until Esc or q; the projects come from `watcher`. */
export async function runTaskExplorer(projectId: string, watcher: ProjectWatcher): Promise<number> {
  watcher.start();
  const app = render(createElement(ExplorerHost, { source: watcher, projectId, onClose: () => { app.unmount(); } }));
  try {
    await app.waitUntilExit();
  } finally {
    await watcher.stop();
  }
  return 0;
}
