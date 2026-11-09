import { Box, Text } from 'ink';
import type { TuiStatus } from './status.ts';
import { formatProjectIdentity } from '../projectHealth.ts';
import { WAITING_INPUT_ANSWER_HINT } from '../waitingInput.ts';

/** `updatedAt` is when the status was loaded, so animation renders leave the header unchanged. */
export function Header({ status, banner, updatedAt }: { status: TuiStatus; banner: string | null; updatedAt: string }) {
  const taskCounts = status.tasks.counts;
  const waitingCount = status.waiting_input?.length ?? 0;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {banner != null ? <Text>{banner}</Text> : null}
      <Text bold wrap="truncate">{formatProjectIdentity(status.project ?? null)}</Text>
      <Text dimColor wrap="truncate">
        capacity: {status.worker_capacity.used_slots}/{status.worker_capacity.configured_slots}
        {' | '}todo: {taskCounts.todo ?? 0}
        {' | '}active: {status.claims.in_progress}
        {' | '}updated: {updatedAt}
      </Text>
      {waitingCount > 0
        ? (
            <Text wrap="truncate">
              <Text bold inverse color="yellow">{` ${waitingCount} WAITING FOR INPUT `}</Text>
              <Text color="yellow">{` answer: ${WAITING_INPUT_ANSWER_HINT}`}</Text>
            </Text>
          )
        : null}
    </Box>
  );
}
