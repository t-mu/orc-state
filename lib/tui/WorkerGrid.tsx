import { Box, Text } from 'ink';
import type { SlotDetail } from './layout.ts';
import type { SpriteMap } from './sprites.ts';
import type { WorkerSlotViewModel } from './status.ts';
import { WorkerSlot } from './WorkerSlot.tsx';

interface WorkerCapacitySummary {
  configured: number;
  used: number;
  available: number;
}

export function WorkerGrid({ slots, sprites, capacity, detail = 'full' }: {
  slots: WorkerSlotViewModel[];
  sprites: SpriteMap;
  capacity: WorkerCapacitySummary;
  detail?: SlotDetail;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="green">
        {'Live Workers  '}
        <Text dimColor>{`(${capacity.used}/${capacity.configured} capacity, ${capacity.available} available)`}</Text>
      </Text>
      <Box flexWrap="wrap">
        {slots.length === 0
          ? <Text dimColor>  (no live workers)</Text>
          : slots.map(slot => (
              <WorkerSlot key={slot.slot_id} slot={slot} sprites={sprites} detail={detail} />
            ))}
      </Box>
    </Box>
  );
}
