import { Box, Text, useInput, useStdin, useStdout } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ATTENTION_BADGE, ATTENTION_COUNT_LABEL, ATTENTION_KINDS, buildDashboardModel, computeDashboardLayout, dashboardAgents,
  mergeFeed, notificationEntries,
  type AgentDetail, type AttentionKind, type DashboardAgent, type DashboardFeedEntry, type DashboardModel, type DashboardProject,
} from './dashboard.ts';
import { MoreLine } from './MoreLine.tsx';
import { buildProjectViews, describeConnection, type TuiProjectView, type TuiWatchSource } from './status.ts';

export interface AppProps {
  /** The project watcher (orc-state/client) the dashboard reads every project from. */
  source: TuiWatchSource;
  /** State directory of the project the dashboard was started for; it is listed first. */
  stateDir: string;
  /** Re-read the watcher at least this often, besides on each of its updates. */
  intervalMs?: number;
}

const CONNECTION_COLOR: Record<TuiProjectView['connection'], string> = {
  running: 'green',
  connecting: 'cyan',
  stopped: 'yellow',
  unreachable: 'red',
  incompatible: 'red',
};

/** Badge colours: each kind is told apart by text and colour. */
const ATTENTION_COLOR: Record<AttentionKind, string> = {
  permission_prompt: 'red',
  question: 'yellow',
  stalled: 'magenta',
  no_progress: 'cyan',
};

/** Terminal size, updated on `resize`. Undefined rows (no TTY) disables the height budget. */
function useTerminalRows(): number | undefined {
  const { stdout } = useStdout();
  const [rows, setRows] = useState(() => stdout.rows);
  useEffect(() => {
    const onResize = () => setRows(stdout.rows);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return rows;
}

/**
 * The model, rebuilt on each watcher update and every `intervalMs`, but only
 * stored (so rendered) when it differs from the last one: unchanged data does
 * not repaint the screen. Notification events are kept from both the stream
 * and each status's recent events, so the feed outlives the status window.
 */
function useDashboardModel(source: TuiWatchSource, stateDir: string, intervalMs: number): DashboardModel {
  const feedRef = useRef<DashboardFeedEntry[]>([]);
  const keyRef = useRef('');
  const build = (registryError: string | null): DashboardModel => {
    const views = buildProjectViews(source.projects());
    const incoming = views.flatMap(view => notificationEntries({ project_id: view.project_id, name: view.name }, view.status?.recentEvents ?? []));
    feedRef.current = mergeFeed(feedRef.current, incoming);
    return buildDashboardModel(views, stateDir, feedRef.current, registryError);
  };
  const [model, setModel] = useState(() => {
    const initial = build(null);
    keyRef.current = JSON.stringify(initial);
    return initial;
  });

  useEffect(() => {
    let registryError: string | null = null;
    const refresh = () => {
      const next = build(registryError);
      const key = JSON.stringify(next);
      if (key === keyRef.current) return;
      keyRef.current = key;
      setModel(next);
    };
    const unsubscribe = source.onUpdate((update) => {
      if (update.type === 'registry_error') registryError = update.error.message;
      else if (update.type === 'added' || update.type === 'removed') registryError = null;
      else if (update.type === 'event' && update.row.event) {
        const project = source.projects().find(state => state.project.id === update.project_id)?.project;
        if (project) {
          const event = { ...update.row.event, seq: update.row.seq } as Parameters<typeof notificationEntries>[1][number];
          feedRef.current = mergeFeed(feedRef.current, notificationEntries({ project_id: project.id, name: project.name }, [event]));
        }
      }
      refresh();
    });
    refresh();
    const timer = setInterval(refresh, intervalMs);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
    // `build` reads only `source` and `stateDir`.
  }, [intervalMs, source, stateDir]);

  return model;
}

/** The selected agent's key, moved with ↑/↓ (or k/j); follows the agent when the list reorders. */
function useSelection(agents: DashboardAgent[]): string | null {
  const { isRawModeSupported } = useStdin();
  const [selected, setSelected] = useState<string | null>(null);
  const index = Math.max(0, agents.findIndex(agent => agent.key === selected));
  const current = agents[index]?.key ?? null;

  useInput((input, key) => {
    if (agents.length === 0) return;
    let next = index;
    if (key.upArrow || input === 'k') next = Math.max(0, index - 1);
    else if (key.downArrow || input === 'j') next = Math.min(agents.length - 1, index + 1);
    else return;
    setSelected(agents[next].key);
  }, { isActive: isRawModeSupported === true });

  return current;
}

export function App({ source, stateDir, intervalMs = 3000 }: AppProps) {
  const model = useDashboardModel(source, stateDir, intervalMs);
  const rows = useTerminalRows();
  const layout = useMemo(() => computeDashboardLayout(model, rows), [model, rows]);
  const agents = useMemo(() => dashboardAgents(model), [model]);
  const selected = useSelection(agents);
  const needYou = model.projects.reduce((sum, project) => sum + project.attentionTotal, 0);

  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Text bold>orc</Text>
        <Text dimColor>{` ${model.projects.length} project${model.projects.length === 1 ? '' : 's'}`}</Text>
        {needYou > 0 ? <Text bold inverse color="yellow">{` ${needYou} NEED${needYou === 1 ? 'S' : ''} YOU `}</Text> : null}
      </Text>
      {model.notice ? <Text color="yellow" wrap="truncate">{model.notice}</Text> : null}
      {model.projects.map(project => (
        <ProjectSection
          key={project.project_id}
          project={project}
          detail={layout.detail}
          maxAgents={layout.maxAgentsPerProject}
          selected={selected}
        />
      ))}
      <Text> </Text>
      <Feed feed={model.feed} maxLines={layout.feedLines} />
    </Box>
  );
}

function connectionLabel(project: DashboardProject): string {
  const label = project.connection === 'stopped' ? 'stopped' : project.connection;
  return project.stale ? `${label} (last known)` : label;
}

function ProjectSection({ project, detail, maxAgents, selected }: {
  project: DashboardProject;
  detail: AgentDetail;
  maxAgents: number;
  selected: string | null;
}) {
  const shown = project.agents.slice(0, maxAgents);
  const counts = ATTENTION_KINDS.filter(kind => project.attention[kind] > 0);
  return (
    <>
      <Text wrap="truncate">
        <Text bold>{project.current ? '▸ ' : '  '}{project.name}</Text>
        {' '}
        <Text color={CONNECTION_COLOR[project.connection]}>{connectionLabel(project)}</Text>
        {project.attentionTotal > 0 ? <Text bold color="yellow">{` ⚠ ${project.attentionTotal}`}</Text> : null}
      </Text>
      {counts.length > 0
        ? (
            <Text wrap="truncate">
              {'  '}
              {counts.map((kind, i) => (
                <Text key={kind} color={ATTENTION_COLOR[kind]}>{`${i > 0 ? ' · ' : ''}${project.attention[kind]} ${ATTENTION_COUNT_LABEL[kind]}`}</Text>
              ))}
            </Text>
          )
        : null}
      {project.error ? <Text color="red" wrap="truncate">{`  ${describeConnection(project)}`}</Text> : null}
      {project.agents.length === 0
        ? <Text dimColor wrap="truncate">{project.connection === 'stopped' && !project.stale ? '    (coordinator not running)' : '    (no live agents)'}</Text>
        : null}
      {shown.map(agent => (
        <AgentRow key={agent.key} agent={agent} detail={detail} selected={agent.key === selected} stale={project.stale} />
      ))}
      <MoreLine hidden={project.agents.length - shown.length} />
    </>
  );
}

function AttentionBadge({ kind }: { kind: AttentionKind }) {
  return <Text bold inverse color={ATTENTION_COLOR[kind]}>{` ${ATTENTION_BADGE[kind]} `}</Text>;
}

/** One agent: its identity row (with the attention badge), then in `full` detail its task and its activity or attention detail. */
function AgentRow({ agent, detail, selected, stale }: { agent: DashboardAgent; detail: AgentDetail; selected: boolean; stale: boolean }) {
  const { attention } = agent;
  const marker = selected ? '› ' : '  ';
  const where = [agent.task_ref, agent.phase ?? agent.state].filter(Boolean).join(' · ');
  return (
    <>
      <Text wrap="truncate" inverse={selected} dimColor={stale && !selected}>
        {marker}
        <Text bold>{agent.agent_id}</Text>
        {' '}
        {attention ? <AttentionBadge kind={attention.kind} /> : <Text dimColor>{agent.state}</Text>}
        {detail === 'compact' && agent.task_ref ? <Text dimColor>{` ${agent.task_ref}`}</Text> : null}
      </Text>
      {detail === 'full'
        ? (
            <>
              <Text dimColor wrap="truncate">{`    ${where || agent.role}`}</Text>
              <AgentDetailLine agent={agent} />
            </>
          )
        : null}
    </>
  );
}

function AgentDetailLine({ agent }: { agent: DashboardAgent }) {
  const { attention } = agent;
  if (attention?.kind === 'question' || attention?.kind === 'permission_prompt') {
    return <Text color={ATTENTION_COLOR[attention.kind]} wrap="truncate">{`    ? ${attention.detail ?? '(text unavailable)'}`}</Text>;
  }
  if (attention?.kind === 'no_progress') {
    return <Text color={ATTENTION_COLOR.no_progress} wrap="truncate">{`    no progress${attention.detail ? ` in ${attention.detail}` : ''}`}</Text>;
  }
  if (attention?.kind === 'stalled') {
    return <Text color={ATTENTION_COLOR.stalled} wrap="truncate">{`    stalled${agent.activity ? `: ${agent.activity}` : ''}`}</Text>;
  }
  return <Text dimColor wrap="truncate">{`    └ ${agent.activity ?? '(no activity)'}`}</Text>;
}

function formatTime(ts: string | null): string {
  const time = ts ? new Date(ts) : null;
  if (!time || !Number.isFinite(time.getTime())) return '--:--';
  return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
}

const FEED_COLOR: Record<string, string | undefined> = {
  run_failed: 'red',
  run_cancelled: 'yellow',
  worker_needs_attention: 'yellow',
  input_requested: 'yellow',
  run_finished: 'green',
};

/** Notification events across projects, newest first; cut to the newest `maxLines`. */
function Feed({ feed, maxLines }: { feed: DashboardFeedEntry[]; maxLines: number }) {
  const shown = maxLines > 0 ? feed.slice(-maxLines).reverse() : [];
  return (
    <>
      <Text bold color="magenta">Notifications</Text>
      {feed.length === 0
        ? <Text dimColor>  (none)</Text>
        : shown.map(entry => {
            const slug = entry.task_ref?.split('/').slice(1).join('/') ?? '';
            // The event first: at a narrow width the tail is what gets cut.
            const parts = [`${entry.event}${entry.reason ? `:${entry.reason}` : ''}`, entry.project, entry.agent_id, slug].filter(Boolean);
            const color = FEED_COLOR[entry.event];
            return (
              <Text key={entry.key} wrap="truncate">
                <Text dimColor>{`${formatTime(entry.ts)} `}</Text>
                {color ? <Text color={color}>{parts.join(' ')}</Text> : parts.join(' ')}
              </Text>
            );
          })}
    </>
  );
}
