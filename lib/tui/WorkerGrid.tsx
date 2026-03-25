import { Box, Text } from 'ink';
import type { SpriteMap } from './sprites.ts';
import type { WorkerSlotViewModel } from './status.ts';
import { WorkerSlot } from './WorkerSlot.tsx';

export function WorkerGrid({ slots, sprites }: { slots: WorkerSlotViewModel[]; sprites: SpriteMap }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="green">
        Worker Slots
      </Text>
      <Box flexWrap="wrap">
        {slots.map(slot => (
          <WorkerSlot key={slot.slot_id} slot={slot} sprites={sprites} />
        ))}
      </Box>
    </Box>
  );
}
