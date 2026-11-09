import { Box, Text } from 'ink';
import { EVENT_FEED_LIMIT, fitList } from './layout.ts';
import { MoreLine } from './MoreLine.tsx';
import type { TuiRecentEvent } from './status.ts';

export function EventFeed({ events, eventReadError, maxLines = Infinity }: {
  events: TuiRecentEvent[];
  eventReadError?: string;
  maxLines?: number;
}) {
  // Keep the newest events: fit the list newest-first, then show it oldest-first.
  const { shown, hidden } = fitList(events.slice(-EVENT_FEED_LIMIT).reverse(), maxLines);
  return (
    <Box flexDirection="column">
      <Text bold color="magenta">
        Recent Events
      </Text>
      {eventReadError ? <Text color="yellow" wrap="truncate">{eventReadError}</Text> : null}
      {events.length === 0 ? (
        <Text dimColor>(none)</Text>
      ) : (
        <>
          <MoreLine hidden={hidden} />
          {shown.reverse().map((event, index) => {
            const taskSlug = event.task_ref?.split('/').slice(1).join('/') ?? '';
            return (
              <Text key={`${event.seq ?? index}-${event.event ?? 'unknown'}`} dimColor wrap="truncate">
                {event.agent_id ? `${event.agent_id} ` : '  '}{event.event ?? 'unknown'}{taskSlug ? ` ${taskSlug}` : ''}
              </Text>
            );
          })}
        </>
      )}
    </Box>
  );
}
