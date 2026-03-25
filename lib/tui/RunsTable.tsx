import { Box, Text } from 'ink';
import type { TuiClaim } from './status.ts';

export function RunsTable({ runs }: { runs: TuiClaim[] }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        Active Runs
      </Text>
      {runs.length === 0 ? (
        <Text dimColor>(none)</Text>
      ) : (
        runs.map(run => (
          <Box key={run.run_id}>
            <Text>{truncate(run.run_id, 18).padEnd(18)}</Text>
            <Text> </Text>
            <Text>{truncate(run.task_ref ?? '—', 28).padEnd(28)}</Text>
            <Text> </Text>
            <Text>{(run.state ?? 'unknown').padEnd(12)}</Text>
            <Text> </Text>
            <Text dimColor>idle {run.idle_seconds ?? '--'}s</Text>
          </Box>
        ))
      )}
    </Box>
  );
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}
