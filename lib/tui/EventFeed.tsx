import { Box, Text } from 'ink';
import type { TuiRecentEvent } from './status.ts';

export function EventFeed({ events, eventReadError }: { events: TuiRecentEvent[]; eventReadError?: string }) {
  return (
    <Box flexDirection="column">
      <Text bold color="magenta">
        Recent Events
      </Text>
      {eventReadError ? <Text color="yellow">{eventReadError}</Text> : null}
      {events.length === 0 ? (
        <Text dimColor>(none)</Text>
      ) : (
        events.slice(-10).map((event, index) => (
          <Text key={`${event.seq ?? index}-${event.event ?? 'unknown'}`} dimColor>
            {event.event ?? 'unknown'} {event.run_id ?? event.task_ref ?? ''}
          </Text>
        ))
      )}
    </Box>
  );
}
