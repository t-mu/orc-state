import { Box, Text } from 'ink';
import { fitList } from './layout.ts';
import { MoreLine } from './MoreLine.tsx';
import type { TuiScout } from './status.ts';

/** Scouts are ad-hoc sessions, not capacity: one line per scout id and state. */
export function ScoutList({ scouts, maxLines = Infinity }: { scouts: TuiScout[]; maxLines?: number }) {
  const { shown, hidden } = fitList(scouts, maxLines);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        Scouts ({scouts.length})
      </Text>
      {scouts.length === 0 ? (
        <Text dimColor>(none)</Text>
      ) : (
        shown.map(scout => (
          <Text key={scout.agent_id} wrap="truncate">
            {scout.agent_id.padEnd(12)}
            {' '}
            {scout.status.padEnd(10)}
            {' '}
            <Text dimColor>{scout.session_handle ? 'attached' : 'detached'}</Text>
          </Text>
        ))
      )}
      <MoreLine hidden={hidden} />
    </Box>
  );
}
