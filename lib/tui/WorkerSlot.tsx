import { Box, Text } from 'ink';
import { OrcSprite } from './OrcSprite.tsx';
import type { SpriteMap } from './sprites.ts';
import type { WorkerSlotViewModel } from './status.ts';

export function WorkerSlot({ slot, sprites }: { slot: WorkerSlotViewModel; sprites: SpriteMap }) {
  const roleColor = slot.role === 'scout' ? 'cyan' : slot.role === 'reviewer' ? 'magenta' : 'green';
  const borderColor = slot.role === 'scout' ? 'cyan' : slot.role === 'reviewer' ? 'magenta' : 'green';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} width={24} marginRight={1} marginBottom={1}>
      <Text bold>
        {slot.slot_id}
        {' '}
        <Text color={roleColor}>[{slot.role.toUpperCase()}]</Text>
      </Text>
      <OrcSprite spriteState={slot.sprite_state} role={slot.role === 'scout' ? 'scout' : 'worker'} sprites={sprites} />
      <Text>{truncate(slot.task_ref ?? `${slot.provider ?? 'unknown'} ${slot.slot_state}`, 20)}</Text>
      <Text dimColor>{slot.run_state ? `${slot.run_state}${slot.current_phase ? ` (${slot.current_phase})` : ''}` : ''}</Text>
      <Text dimColor>
        age: {formatSeconds(slot.age_seconds)} idle: {formatSeconds(slot.idle_seconds)}
      </Text>
    </Box>
  );
}

function formatSeconds(value: number | null): string {
  if (value == null) return '--';
  return `${value}s`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}
