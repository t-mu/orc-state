import { Text, Box } from 'ink';
import { useEffect, useState } from 'react';
import type { PhaseEntry } from './status.ts';
import { formatActivityLine, isActivityStale, type CurrentActivity } from '../currentActivity.ts';

const INDICATOR: Record<PhaseEntry['state'], { symbol: string; color?: string; dimColor?: boolean }> = {
  done:    { symbol: '●', color: 'green' },
  active:  { symbol: '◐', color: 'white' },
  stale:   { symbol: '◐', color: 'yellow' },
  error:   { symbol: '✗', color: 'red' },
  pending: { symbol: '○', dimColor: true },
};

/** Returns live elapsed seconds since `startedAt`, ticking every second. */
function useElapsed(startedAt: string | null): number | null {
  const [elapsed, setElapsed] = useState<number | null>(() => {
    if (!startedAt) return null;
    return Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  });

  useEffect(() => {
    if (!startedAt) {
      setElapsed(null);
      return;
    }
    const tick = () => {
      setElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000)));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  return elapsed;
}

const ACTIVE_STATES = new Set<PhaseEntry['state']>(['active', 'stale', 'error']);

function PhaseRow({ phase }: { phase: PhaseEntry }) {
  const ind = INDICATOR[phase.state];
  const isLive = ACTIVE_STATES.has(phase.state);
  const elapsed = useElapsed(isLive ? phase.started_at : null);
  const displaySeconds = phase.duration_seconds ?? elapsed;

  return (
    <Box>
      <Text {...(ind.color !== undefined ? { color: ind.color } : {})} {...(ind.dimColor ? { dimColor: true } : {})}>{ind.symbol} {phase.name.padEnd(12)}</Text>
      {displaySeconds != null && (
        <Text dimColor>{formatDuration(displaySeconds)}</Text>
      )}
    </Box>
  );
}

/** Phases whose row carries the ◐ indicator: the activity line goes under it. */
const HALF_STATES = new Set<PhaseEntry['state']>(['active', 'stale']);

/** Default column budget inside a worker slot (36 wide, minus border and padding). */
export const ACTIVITY_LINE_WIDTH = 32;

function ActivityLine({ activity, width }: { activity: CurrentActivity; width: number }) {
  const nowMs = Date.now();
  const line = formatActivityLine(activity, width, nowMs, '  └ ');
  return isActivityStale(activity.ts, nowMs) ? <Text dimColor>{line}</Text> : <Text>{line}</Text>;
}

export function PhaseWizard({ phases, activity = null, width = ACTIVITY_LINE_WIDTH }: {
  phases: PhaseEntry[];
  activity?: CurrentActivity | null;
  width?: number;
}) {
  const activeName = activity ? phases.find((p) => HALF_STATES.has(p.state))?.name ?? null : null;
  return (
    <Box flexDirection="column">
      {phases.map((p) => (
        <Box key={p.name} flexDirection="column">
          <PhaseRow phase={p} />
          {activity && p.name === activeName && <ActivityLine activity={activity} width={width} />}
        </Box>
      ))}
    </Box>
  );
}

export function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}
