import { Box, Text, render, useInput, useStdout } from 'ink';
// React in scope: tsx, running orc from source in a pane whose cwd has no tsconfig, compiles JSX to React.createElement.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { isMouseInput, useMouseClicks } from './mouse.ts';
import type { AttentionKind } from './sidebar.ts';
import { buildProjectViews, type TuiWatchSource } from './status.ts';
import {
  buildTabBarModel, layoutTabBar, tabAttention, tabBarClickTarget, tabBarRows,
  type TabBarModel, type TabBarSegment, type TabBarState,
} from './tabBarModel.ts';

/** What a click does in the cockpit; each resolves to what it did, or rejects with why it failed. */
export interface TabBarActions {
  /** `orc cockpit tab <agent_id|master>`: show the tab in the slot. */
  select: (tab: string) => Promise<string>;
  /** `orc cockpit close <agent_id>`: close the agent's tab. */
  close: (agentId: string) => Promise<string>;
  /** Focus the slot, so keys never stay in the tab bar; a throw is shown in the bar. */
  focusSlot: () => void;
}

export interface TabBarProps {
  /** The cockpit's tab state; a throw is shown in the bar. */
  read: () => TabBarState;
  /** The project watcher (orc-state/client) the attention badges come from. */
  source: TuiWatchSource;
  /** Calls its listener when the tab state may have changed (an `orc cockpit` action ran); returns how to stop. */
  changes?: (onChange: () => void) => () => void;
  /** Re-read the tab state at least this often (it may change without an action: a tab's pane exits). */
  intervalMs?: number;
  actions?: TabBarActions;
  /** Read mouse clicks (tmux SGR reports); off by default, as it writes mode sequences to stdout. */
  mouse?: boolean;
}

/** The fallback re-read: the sidebar's (`orc watch`) refresh, never faster. */
export const TAB_BAR_INTERVAL_MS = 5000;
const DEFAULT_COLUMNS = 80;

const ATTENTION_COLOR: Record<AttentionKind, string> = {
  permission_prompt: 'red',
  question: 'yellow',
  stalled: 'magenta',
  no_progress: 'cyan',
};

/**
 * The model, rebuilt on each change signal and every `intervalMs` (which
 * re-read the tab state) and on each watcher update (new attention, the tab
 * state as last read), but only stored (so rendered) when it differs from the last
 * one: an unchanged tab state does not repaint the bar.
 */
function useTabBarModel({ read, source, changes, intervalMs }: Required<Pick<TabBarProps, 'read' | 'source' | 'intervalMs'>> & { changes: TabBarProps['changes'] | undefined }): TabBarModel {
  // The last tab state read: a watcher update changes only the attention, so it rebuilds from this without reading tmux again.
  const last = useRef<{ state: TabBarState } | { error: string } | null>(null);
  const build = (reread: boolean): TabBarModel => {
    if (reread || !last.current) {
      try {
        last.current = { state: read() };
      } catch (error) {
        last.current = { error: (error as Error).message };
      }
    }
    const current = last.current;
    if ('error' in current) return { tabs: [], notice: `orc cockpit bar: ${current.error}` };
    return buildTabBarModel(current.state, tabAttention(buildProjectViews(source.projects()), current.state.activeProject));
  };
  const keyRef = useRef('');
  const [model, setModel] = useState(() => {
    const initial = build(true);
    keyRef.current = JSON.stringify(initial);
    return initial;
  });
  const refresh = useRef((_reread: boolean) => {});
  refresh.current = (reread) => {
    const next = build(reread);
    const key = JSON.stringify(next);
    if (key === keyRef.current) return;
    keyRef.current = key;
    setModel(next);
  };

  useEffect(() => {
    const unsubscribe = source.onUpdate(() => refresh.current(false));
    const stopChanges = changes?.(() => refresh.current(true));
    const timer = setInterval(() => refresh.current(true), intervalMs);
    return () => {
      clearInterval(timer);
      stopChanges?.();
      unsubscribe();
    };
  }, [changes, intervalMs, source]);
  return model;
}

function useColumns(): number {
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(() => stdout.columns || DEFAULT_COLUMNS);
  useEffect(() => {
    const onResize = () => setColumns(stdout.columns || DEFAULT_COLUMNS);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return columns;
}

/**
 * The cockpit's tab bar: the active project's tabs as bordered tabs, a click
 * showing one in the slot (or closing an agent tab at its close marker). Every
 * click, and any key that reaches it, gives the focus back to the slot.
 */
export function TabBar({ read, source, changes, intervalMs = TAB_BAR_INTERVAL_MS, actions, mouse = false }: TabBarProps) {
  const model = useTabBarModel({ read, source, changes, intervalMs });
  const columns = useColumns();
  const layout = useMemo(() => layoutTabBar(model, columns), [model, columns]);
  const [error, setError] = useState<string | null>(null);

  const focusSlot = () => {
    try {
      actions?.focusSlot();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  const run = (outcome: Promise<string>) => {
    outcome.then(
      () => setError(null),
      (failure: unknown) => setError((failure as Error).message),
    );
  };

  // Reading input puts stdin in raw mode, which mouse reports need; a key is not the bar's to keep.
  useInput((input) => {
    if (!isMouseInput(input)) focusSlot();
  }, { isActive: mouse });

  useMouseClicks(({ x }) => {
    setError(null);
    focusSlot();
    const target = tabBarClickTarget(model, layout, x);
    if (!target || !actions) return;
    if (target.kind === 'close' && target.tab.agentId) run(actions.close(target.tab.agentId));
    else run(actions.select(target.tab.agentId ?? 'master'));
  }, mouse);

  const rows = tabBarRows(model, layout, columns, error);
  return (
    <Box flexDirection="column" width={columns}>
      {rows.map((row, index) => (
        <Text key={index} wrap="truncate">
          {row.length === 0 ? ' ' : row.map((segment, offset) => <Segment key={offset} segment={segment} model={model} />)}
        </Text>
      ))}
    </Box>
  );
}

/** One styled run: the active tab cyan and bold, a badge in its kind's colour, the rest dim. */
function Segment({ segment, model }: { segment: TabBarSegment; model: TabBarModel }) {
  const tab = segment.tab === undefined ? null : model.tabs[segment.tab];
  switch (segment.kind) {
    case 'error':
      return <Text color="red">{segment.text}</Text>;
    case 'notice':
      return <Text color="yellow">{segment.text}</Text>;
    case 'marker':
      return <Text bold>{segment.text}</Text>;
    case 'rule':
      return <Text color="gray">{segment.text}</Text>;
    case 'badge':
      return tab?.attention ? <Text bold color={ATTENTION_COLOR[tab.attention]}>{segment.text}</Text> : <Text>{segment.text}</Text>;
    case 'close':
      return <Text color="gray">{segment.text}</Text>;
    case 'border':
      return <Text color={tab?.active ? 'cyan' : 'gray'}>{segment.text}</Text>;
    case 'text':
      return tab?.active ? <Text bold color="cyan">{segment.text}</Text> : <Text>{segment.text}</Text>;
  }
}

/** Runs the tab bar until its pane closes. */
export async function runTabBar(props: Omit<TabBarProps, 'mouse' | 'source'> & { watcher: TuiWatchSource & { start(): void; stop(): Promise<void> } }): Promise<number> {
  const { watcher, ...rest } = props;
  watcher.start();
  // Start from a clear screen, so nothing printed earlier in the pane shifts the bar.
  process.stdout.write('\x1b[2J\x1b[H');
  const app = render(<TabBar {...rest} source={watcher} mouse />);
  try {
    await app.waitUntilExit();
  } finally {
    await watcher.stop();
  }
  return 0;
}
