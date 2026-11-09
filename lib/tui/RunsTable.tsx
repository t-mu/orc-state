import { Box, Text } from 'ink';
import { fitList } from './layout.ts';
import { MoreLine } from './MoreLine.tsx';
import type { TuiClaim } from './status.ts';

export function RunsTable({ runs, maxLines = Infinity }: { runs: TuiClaim[]; maxLines?: number }) {
  const { shown, hidden } = fitList(runs, maxLines);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        Active Runs
      </Text>
      {runs.length === 0 ? (
        <Text dimColor>(none)</Text>
      ) : (
        shown.map(run => (
          <Text key={run.run_id} wrap="truncate">
            {truncate(run.run_id, 18).padEnd(18)}
            {' '}
            {truncate(run.task_ref ?? '—', 28).padEnd(28)}
            {' '}
            {(run.state ?? 'unknown').padEnd(12)}
            {' '}
            <Text dimColor>idle {run.idle_seconds ?? '--'}s</Text>
          </Text>
        ))
      )}
      <MoreLine hidden={hidden} />
    </Box>
  );
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}
