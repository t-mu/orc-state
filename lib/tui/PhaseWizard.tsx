import { Text, Box } from 'ink';
import { useEffect, useState } from 'react';
import type { PhaseEntry } from './status.ts';

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

export function PhaseWizard({ phases }: { phases: PhaseEntry[] }) {
  return (
    <Box flexDirection="column">
      {phases.map((p) => (
        <PhaseRow key={p.name} phase={p} />
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
