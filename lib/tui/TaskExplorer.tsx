import { Box, Text, useInput, useStdin } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { describeConnection, type TuiProjectView } from './status.ts';
import {
  ALL, clampScroll, cycleOption, detailLines, featureOptions, filterTasks, statusOptions, windowStart,
  type ProjectTaskSummary, type ProjectTaskView, type TaskRevisionSummary, type TuiTaskClient,
} from './taskList.ts';

export interface TaskExplorerProps {
  /** Every watched project; ←/→ switch between them. */
  projects: Pick<TuiProjectView, 'project_id' | 'name' | 'state_dir' | 'connection' | 'error'>[];
  /** The project shown first (the first one when absent or unknown). */
  initialProjectId: string | null;
  /** A read-only task client for a project's state directory. */
  createClient: (stateDir: string) => TuiTaskClient;
  /** Terminal height; undefined (no TTY) shows every row. */
  rows: number | undefined;
  /** Terminal width the spec is wrapped to (80 when unknown). */
  columns: number | undefined;
}

type Load<T> = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; value: T };

const STATUS_COLOR: Record<string, string | undefined> = {
  claimed: 'cyan',
  in_progress: 'cyan',
  blocked: 'red',
  done: 'green',
};

function statusColor(status: string): { color?: string } {
  const color = STATUS_COLOR[status];
  return color ? { color } : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why a project's tasks cannot be read right now, or null when its coordinator runs. */
function unavailableReason(project: TaskExplorerProps['projects'][number]): string | null {
  switch (project.connection) {
    case 'running': return null;
    case 'connecting': return 'connecting to the coordinator…';
    case 'stopped': return 'coordinator not running: start it to browse this project\'s tasks';
    default: return describeConnection(project);
  }
}

/**
 * Read-only task explorer: a project's tasks with status/feature filters, and
 * a task's spec and revisions. Reads only through the task GET routes.
 */
export function TaskExplorer({ projects, initialProjectId, createClient, rows, columns }: TaskExplorerProps) {
  const { isRawModeSupported } = useStdin();
  const [projectId, setProjectId] = useState(initialProjectId);
  const projectIndex = Math.max(0, projects.findIndex(project => project.project_id === projectId));
  const project = projects[projectIndex] ?? null;
  const reason = project ? unavailableReason(project) : null;

  const [reload, setReload] = useState(0);
  const [list, setList] = useState<Load<ProjectTaskSummary[]>>({ kind: 'loading' });
  const [filter, setFilter] = useState({ status: ALL, feature: ALL });
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [openRef, setOpenRef] = useState<string | null>(null);
  const [detail, setDetail] = useState<Load<{ task: ProjectTaskView; revisions: TaskRevisionSummary[] }>>({ kind: 'loading' });
  const [scroll, setScroll] = useState(0);

  const stateDir = project?.state_dir ?? null;
  useEffect(() => {
    if (!stateDir || reason) return;
    let live = true;
    setList({ kind: 'loading' });
    createClient(stateDir).listTasks({ fields: 'summary' })
      .then(({ tasks }) => { if (live) setList({ kind: 'ready', value: tasks }); })
      .catch((error: unknown) => { if (live) setList({ kind: 'error', message: errorMessage(error) }); });
    return () => { live = false; };
  }, [stateDir, reason, reload, createClient]);

  useEffect(() => {
    if (!stateDir || !openRef) return;
    let live = true;
    setDetail({ kind: 'loading' });
    setScroll(0);
    const client = createClient(stateDir);
    Promise.all([client.getTask(openRef), client.taskRevisions(openRef)])
      .then(([{ task }, { revisions }]) => { if (live) setDetail({ kind: 'ready', value: { task, revisions } }); })
      .catch((error: unknown) => { if (live) setDetail({ kind: 'error', message: errorMessage(error) }); });
    return () => { live = false; };
  }, [stateDir, openRef, createClient]);

  const tasks = list.kind === 'ready' ? list.value : [];
  const shown = useMemo(() => filterTasks(tasks, filter), [tasks, filter]);
  const selectedIndex = Math.max(0, shown.findIndex(task => task.ref === selectedRef));
  const selected = shown[selectedIndex] ?? null;

  const width = Math.max(10, (columns ?? 80) - 1);
  const lines = useMemo(
    () => (detail.kind === 'ready' ? detailLines(detail.value.task, detail.value.revisions, width) : []),
    [detail, width],
  );
  // Header, footer and one spare row keep the frame below the terminal height.
  const page = rows === undefined ? lines.length : Math.max(1, rows - 3);

  const switchProject = (step: number) => {
    if (projects.length < 2) return;
    const next = projects[(projectIndex + step + projects.length) % projects.length];
    setProjectId(next.project_id);
    setFilter({ status: ALL, feature: ALL });
    setSelectedRef(null);
  };

  useInput((input, key) => {
    if (openRef) {
      let next = scroll;
      if (key.escape || key.backspace || key.delete || key.leftArrow || input === 'q' || input === 'h') {
        setOpenRef(null);
        return;
      }
      if (key.upArrow || input === 'k') next = scroll - 1;
      else if (key.downArrow || input === 'j') next = scroll + 1;
      else if (key.pageUp || input === 'b') next = scroll - page;
      else if (key.pageDown || input === ' ') next = scroll + page;
      else if (input === 'g') next = 0;
      else if (input === 'G') next = lines.length;
      else return;
      setScroll(clampScroll(next, lines.length, page));
      return;
    }
    if (key.leftArrow || input === 'h') switchProject(-1);
    else if (key.rightArrow || input === 'l') switchProject(1);
    else if (input === 'r') setReload(n => n + 1);
    else if (input === 's') setFilter(f => ({ ...f, status: cycleOption(statusOptions(tasks), f.status) }));
    else if (input === 'f') setFilter(f => ({ ...f, feature: cycleOption(featureOptions(tasks), f.feature) }));
    else if (shown.length === 0) return;
    else if (key.upArrow || input === 'k') setSelectedRef(shown[Math.max(0, selectedIndex - 1)].ref);
    else if (key.downArrow || input === 'j') setSelectedRef(shown[Math.min(shown.length - 1, selectedIndex + 1)].ref);
    else if (key.return && selected) setOpenRef(selected.ref);
  }, { isActive: isRawModeSupported === true });

  if (!project) {
    return <Text dimColor>(no registered projects)</Text>;
  }

  if (openRef) {
    const visible = lines.slice(scroll, scroll + page);
    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate">{`‹ ${openRef}`}</Text>
        {detail.kind === 'loading' ? <Text dimColor>loading…</Text> : null}
        {detail.kind === 'error' ? <Text color="red" wrap="truncate">{`cannot read task: ${detail.message}`}</Text> : null}
        {visible.map((line, i) => <Text key={scroll + i} wrap="truncate">{line || ' '}</Text>)}
        <Text dimColor wrap="truncate">
          {lines.length > 0 ? `${scroll + 1}-${Math.min(lines.length, scroll + page)}/${lines.length} ` : ''}
          ↑↓ scroll · PgUp/PgDn · Esc back
        </Text>
      </Box>
    );
  }

  // Header, filter line, selected task's two lines, footer and one spare row.
  const listRows = rows === undefined ? shown.length : Math.max(1, rows - 6);
  const start = windowStart(selectedIndex, shown.length, listRows);
  const visible = shown.slice(start, start + listRows);
  const statusWidth = Math.max(0, ...shown.map(task => task.status.length));

  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Text bold>Tasks</Text>
        {` ${project.name}`}
        {projects.length > 1 ? <Text dimColor>{` (${projectIndex + 1}/${projects.length} ←→)`}</Text> : null}
      </Text>
      {reason
        ? <Text color={project.connection === 'stopped' || project.connection === 'connecting' ? 'yellow' : 'red'} wrap="truncate">{`  ${reason}`}</Text>
        : null}
      {!reason && list.kind === 'loading' ? <Text dimColor>  loading…</Text> : null}
      {!reason && list.kind === 'error' ? <Text color="red" wrap="truncate">{`  cannot list tasks: ${list.message}`}</Text> : null}
      {!reason && list.kind === 'ready'
        ? (
            <>
              <Text dimColor wrap="truncate">{`status: ${filter.status} · feature: ${filter.feature} · ${shown.length}/${tasks.length}`}</Text>
              {tasks.length === 0 ? <Text dimColor>  (no tasks in this project)</Text> : null}
              {tasks.length > 0 && shown.length === 0 ? <Text dimColor>  (no tasks match the filter)</Text> : null}
              {visible.map(task => (
                <Text key={task.ref} wrap="truncate" inverse={task.ref === selected?.ref}>
                  {task.ref === selected?.ref ? '› ' : '  '}
                  <Text {...statusColor(task.status)} dimColor={task.status === 'cancelled'}>{task.status.padEnd(statusWidth)}</Text>
                  {` ${task.ref} `}
                  <Text dimColor>{task.title}</Text>
                </Text>
              ))}
              {selected
                ? (
                    <>
                      <Text wrap="truncate">{`  ${selected.title}`}</Text>
                      <Text dimColor wrap="truncate">
                        {`  priority: ${selected.priority ?? 'normal'} · depends on: ${selected.depends_on?.length ? selected.depends_on.join(', ') : '(none)'}`}
                      </Text>
                    </>
                  )
                : null}
            </>
          )
        : null}
      <Text dimColor wrap="truncate">↑↓ select · ⏎ open · s status · f feature · r reload · t dashboard</Text>
    </Box>
  );
}
