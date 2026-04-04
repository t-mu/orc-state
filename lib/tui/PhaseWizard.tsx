import { Text, Box } from 'ink';
import type { PhaseEntry } from './status.ts';

const INDICATOR: Record<PhaseEntry['state'], { symbol: string; color?: string; dimColor?: boolean }> = {
  done:    { symbol: '●', color: 'green' },
  active:  { symbol: '◐', color: 'white' },
  stale:   { symbol: '◐', color: 'yellow' },
  error:   { symbol: '✗', color: 'red' },
  pending: { symbol: '○', dimColor: true },
};

export function PhaseWizard({ phases }: { phases: PhaseEntry[] }) {
  return (
    <Box flexDirection="column">
      {phases.map((p) => {
        const ind = INDICATOR[p.state];
        return (
          <Box key={p.name}>
            <Text {...(ind.color !== undefined ? { color: ind.color } : {})} {...(ind.dimColor ? { dimColor: true } : {})}>{ind.symbol} {p.name.padEnd(12)}</Text>
            {p.duration_seconds != null && (
              <Text dimColor>{formatDuration(p.duration_seconds)}</Text>
            )}
          </Box>
        );
      })}
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
