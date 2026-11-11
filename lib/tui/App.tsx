import { Box, Text, useInput, useStdin, useStdout } from 'ink';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  agentRowParts, buildSidebarModel, computeSidebarLayout, fitRow, fitText,
  type AttentionKind, type SidebarAgent, type SidebarModel, type SidebarProject, type SidebarProjectState,
} from './sidebar.ts';
import { buildProjectViews, type TuiWatchSource } from './status.ts';

export interface AppProps {
  /** The project watcher (orc-state/client) the sidebar reads every project from. */
  source: TuiWatchSource;
  /** State directory of the project the sidebar was started for; it is the active one until another is selected. */
  stateDir: string;
  /** Re-read the watcher at least this often, besides on each of its updates. */
  intervalMs?: number;
  /** The clock elapsed times are measured with. */
  now?: () => number;
}

/** The key bindings line, at most 32 columns (the sidebar's inside). */
export const KEYS_HINT = '↑↓ Tab ⏎ select';
/** Selecting an agent: `orc watch` only shows it. */
export const NO_COCKPIT_HINT = 'terminals open in the cockpit';

/** The sidebar's width without a TTY. */
const DEFAULT_COLUMNS = 34;

const STATE_COLOR: Record<SidebarProjectState, string> = {
  running: 'green',
  connecting: 'cyan',
  stopped: 'yellow',
  stale: 'red',
  incompatible: 'red',
};

/** Badge colours: each kind is told apart by text and colour. */
const ATTENTION_COLOR: Record<AttentionKind, string> = {
  permission_prompt: 'red',
  question: 'yellow',
  stalled: 'magenta',
  no_progress: 'cyan',
};

type Focus = 'projects' | 'agents';

/** Terminal size, updated on `resize`. Undefined rows (no TTY) disables the height budget. */
function useTerminalSize(): { rows: number | undefined; columns: number | undefined } {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({ rows: stdout.rows, columns: stdout.columns }));
  useEffect(() => {
    const onResize = () => setSize({ rows: stdout.rows, columns: stdout.columns });
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

/**
 * The model, rebuilt on each watcher update and every `intervalMs`, but only
 * stored (so rendered) when it differs from the last one: unchanged data does
 * not repaint the screen. `setActive` makes a project the active one.
 */
function useSidebarModel(props: Required<Pick<AppProps, 'source' | 'stateDir' | 'intervalMs' | 'now'>>): {
  model: SidebarModel;
  setActive: (projectId: string) => void;
} {
  const { source, stateDir, intervalMs, now } = props;
  const chosen = useRef<string | null>(null);
  const registryError = useRef<string | null>(null);
  const keyRef = useRef('');
  const build = (): SidebarModel => buildSidebarModel(buildProjectViews(source.projects()), {
    stateDir, activeProjectId: chosen.current, nowMs: now(), registryError: registryError.current,
  });
  const [model, setModel] = useState(() => {
    const initial = build();
    keyRef.current = JSON.stringify(initial);
    return initial;
  });
  const refresh = useRef(() => {});
  refresh.current = () => {
    const next = build();
    const key = JSON.stringify(next);
    if (key === keyRef.current) return;
    keyRef.current = key;
    setModel(next);
  };
  useEffect(() => {
    const unsubscribe = source.onUpdate((update) => {
      if (update.type === 'registry_error') registryError.current = update.error.message;
      else if (update.type === 'added' || update.type === 'removed') registryError.current = null;
      refresh.current();
    });
    refresh.current();
    const timer = setInterval(() => {
      refresh.current();
    }, intervalMs);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [intervalMs, source]);

  return {
    model,
    setActive: (projectId) => {
      chosen.current = projectId;
      refresh.current();
    },
  };
}

/** Index of the item whose key is `key` in `keys`, else `fallback` (clamped). */
function indexOf(keys: string[], key: string | null, fallback: number): number {
  const index = key == null ? -1 : keys.indexOf(key);
  return index >= 0 ? index : Math.max(0, Math.min(fallback, keys.length - 1));
}

export function App({ source, stateDir, intervalMs = 3000, now = Date.now }: AppProps) {
  const { model, setActive } = useSidebarModel({ source, stateDir, intervalMs, now });
  const { rows, columns } = useTerminalSize();
  const { isRawModeSupported } = useStdin();
  const keys = isRawModeSupported === true;
  const width = Math.max(12, columns ?? DEFAULT_COLUMNS);

  const [focus, setFocus] = useState<Focus>('agents');
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [agentKey, setAgentKey] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const projectIndex = indexOf(model.projects.map(project => project.project_id), projectKey ?? model.activeProjectId, 0);
  const agentIndex = indexOf(model.agents.map(agent => agent.key), agentKey, 0);
  // The footer (key bindings, or what the last selection did) only where keys are read.
  const layout = useMemo(
    () => computeSidebarLayout(model, rows == null || !keys ? rows : rows - 1, { project: projectIndex, agent: agentIndex }),
    [model, rows, keys, projectIndex, agentIndex],
  );
  const activeProjectView = model.projects.find(project => project.active) ?? null;

  const selectProject = (project: SidebarProject) => {
    setProjectKey(project.project_id);
    if (project.project_id !== model.activeProjectId) setAgentKey(null);
    setActive(project.project_id);
    setResult(null);
  };
  const openAgent = (agent: SidebarAgent) => {
    setAgentKey(agent.key);
    setResult(NO_COCKPIT_HINT);
  };

  useInput((input, key) => {
    if (key.tab) {
      setFocus(current => (current === 'projects' ? 'agents' : 'projects'));
      setResult(null);
      return;
    }
    const list = focus === 'projects' ? model.projects.length : model.agents.length;
    if (list === 0) return;
    const current = focus === 'projects' ? projectIndex : agentIndex;
    if (key.return) {
      if (focus === 'projects') selectProject(model.projects[current]);
      else openAgent(model.agents[current]);
      return;
    }
    let next: number;
    if (key.upArrow || input === 'k') next = Math.max(0, current - 1);
    else if (key.downArrow || input === 'j') next = Math.min(list - 1, current + 1);
    else return;
    setResult(null);
    if (focus === 'projects') setProjectKey(model.projects[next].project_id);
    else setAgentKey(model.agents[next].key);
  }, { isActive: keys });

  const inner = width - 2;
  return (
    <Box flexDirection="column" width={width}>
      <Panel title="Status" width={width} focused={false}>
        <StatusLines model={model} width={inner} />
      </Panel>
      <Panel title="Projects" width={width} focused={keys && focus === 'projects'}>
        {model.projects.length === 0 ? <Text dimColor wrap="truncate">(none)</Text> : null}
        {model.projects.slice(layout.projectStart, layout.projectStart + layout.projectCount).map((project, offset) => (
          <ProjectRow
            key={project.project_id}
            project={project}
            width={inner}
            cursor={keys && focus === 'projects' && layout.projectStart + offset === projectIndex}
          />
        ))}
        <MoreRow hidden={model.projects.length - layout.projectCount} />
      </Panel>
      <Panel title={activeProjectView ? `Agents · ${activeProjectView.name}` : 'Agents'} width={width} focused={keys && focus === 'agents'}>
        {model.agents.length === 0
          ? <Text dimColor wrap="truncate">{activeProjectView?.state === 'stopped' && !model.agentsStale ? '(coordinator not running)' : '(no live agents)'}</Text>
          : null}
        {layout.agents.map(index => (
          <AgentRows
            key={model.agents[index].key}
            agent={model.agents[index]}
            width={inner}
            cursor={keys && focus === 'agents' && index === agentIndex}
            stale={model.agentsStale}
          />
        ))}
        <MoreRow hidden={model.agents.length - layout.agents.length} />
      </Panel>
      {keys
        ? result
          ? <Text color="green" wrap="truncate">{result}</Text>
          : <Text dimColor wrap="truncate">{KEYS_HINT}</Text>
        : null}
    </Box>
  );
}

/** A box with rounded borders and its title in the top border; cyan while it has the keys. */
function Panel({ title, width, focused, children }: { title: string; width: number; focused: boolean; children: ReactNode }) {
  const label = fitText(title, Math.max(0, width - 6));
  const color = focused ? 'cyan' : 'gray';
  return (
    <Box flexDirection="column" width={width}>
      <Text color={color}>
        {'╭─ '}
        <Text bold {...(focused ? { color: 'cyan' } : {})}>{label}</Text>
        {` ${'─'.repeat(Math.max(0, width - label.length - 5))}╮`}
      </Text>
      <Box flexDirection="column" width={width} borderStyle="round" borderTop={false} borderColor={color}>
        {children}
      </Box>
    </Box>
  );
}

function MoreRow({ hidden }: { hidden: number }) {
  return hidden > 0 ? <Text dimColor wrap="truncate">{`+${hidden} more`}</Text> : null;
}

/** The active project's coordinator, its worker capacity, and how many agents need a human across projects. */
function StatusLines({ model, width }: { model: SidebarModel; width: number }) {
  const { coordinator, workers, attention } = model.status;
  const need = attention > 0 ? `${attention} need${attention === 1 ? 's' : ''} you` : '';
  const row = fitRow(`workers ${workers ? `${workers.used}/${workers.total}` : '-'}`, need, width);
  return (
    <>
      <Text wrap="truncate">
        {'coordinator '}
        {coordinator ? <Text color={STATE_COLOR[coordinator]}>{coordinator}</Text> : <Text dimColor>-</Text>}
      </Text>
      <Text wrap="truncate">
        {row.left}
        {row.gap}
        <Text bold color="yellow">{row.right}</Text>
      </Text>
      {model.notice ? <Text color="yellow" wrap="truncate">{model.notice}</Text> : null}
    </>
  );
}

/** `▸` marks the active project; then its state and, when its agents need a human, `!N`. */
function ProjectRow({ project, width, cursor }: { project: SidebarProject; width: number; cursor: boolean }) {
  const badge = project.attention > 0 ? ` !${project.attention}` : '';
  const row = fitRow(project.name, `${project.state}${badge}`, width - 2);
  const whole = row.right === `${project.state}${badge}`;
  return (
    <Text wrap="truncate" inverse={cursor}>
      <Text bold={project.active}>{project.active ? '▸ ' : '  '}{row.left}</Text>
      {row.gap}
      {whole
        ? (
            <>
              <Text color={STATE_COLOR[project.state]}>{project.state}</Text>
              {badge ? <Text bold color="yellow">{badge}</Text> : null}
            </>
          )
        : row.right}
    </Text>
  );
}

/** An agent's two rows: name, phase (or attention badge) and run time; then its activity, or its question or reason. */
function AgentRows({ agent, width, cursor, stale }: { agent: SidebarAgent; width: number; cursor: boolean; stale: boolean }) {
  const parts = agentRowParts(agent, width);
  const { attention } = agent;
  return (
    <>
      <Text wrap="truncate" inverse={cursor} dimColor={stale && !cursor}>
        <Text bold>{parts.name}</Text>
        {parts.gap}
        {attention
          ? <Text bold inverse={!cursor} color={ATTENTION_COLOR[attention]}>{parts.tag}</Text>
          : <Text dimColor={!cursor}>{parts.tag}</Text>}
        <Text dimColor={!cursor}>{parts.elapsed}</Text>
      </Text>
      <Text wrap="truncate" dimColor={!attention} {...(attention ? { color: ATTENTION_COLOR[attention] } : {})}>
        {`  ${agent.detail ?? ''}`}
      </Text>
    </>
  );
}
