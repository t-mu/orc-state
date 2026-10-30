import { Box, Text } from 'ink';
import type { TuiScout } from './status.ts';

/** Scouts are ad-hoc sessions, not capacity: one line per scout id and state. */
export function ScoutList({ scouts }: { scouts: TuiScout[] }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        Scouts ({scouts.length})
      </Text>
      {scouts.length === 0 ? (
        <Text dimColor>(none)</Text>
      ) : (
        scouts.map(scout => (
          <Box key={scout.agent_id}>
            <Text>{scout.agent_id.padEnd(12)}</Text>
            <Text> </Text>
            <Text>{scout.status.padEnd(10)}</Text>
            <Text> </Text>
            <Text dimColor>{scout.session_handle ? 'attached' : 'detached'}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}
