import { Box, Text } from 'ink';
import { renderBanner } from '../banner.ts';
import type { TuiStatus } from './status.ts';

export function Header({ status }: { status: TuiStatus }) {
  const taskCounts = status.tasks.counts;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>{renderBanner()}</Text>
      <Text dimColor>
        slots: {status.worker_capacity.used_slots}/{status.worker_capacity.configured_slots}
        {' | '}todo: {taskCounts.todo ?? 0}
        {' | '}active: {status.claims.in_progress}
        {' | '}updated: {new Date().toISOString()}
      </Text>
    </Box>
  );
}
