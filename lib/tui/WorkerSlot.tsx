import { Box, Text } from 'ink';
import { OrcSprite } from './OrcSprite.tsx';
import { PhaseWizard } from './PhaseWizard.tsx';
import type { SpriteMap } from './sprites.ts';
import type { WorkerSlotViewModel } from './status.ts';

export function WorkerSlot({ slot, sprites }: { slot: WorkerSlotViewModel; sprites: SpriteMap }) {
  const roleColor = slot.role === 'scout' ? 'cyan' : slot.role === 'reviewer' ? 'magenta' : 'green';
  const borderColor = slot.role === 'scout' ? 'cyan' : slot.role === 'reviewer' ? 'magenta' : 'green';
  const providerLabel = slot.provider ?? 'unknown';
  const modelLabel = slot.model ? ` ${slot.model}` : '';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} flexGrow={1} flexBasis={20} width={36} marginRight={1} marginBottom={1}>
      <Text bold>
        {slot.slot_id}
        {' '}
        <Text color={roleColor}>[{slot.role.toUpperCase()}]</Text>
      </Text>
      <Text dimColor>{providerLabel}{modelLabel}</Text>
      <OrcSprite spriteState={slot.sprite_state} role={slot.role === 'scout' ? 'scout' : 'worker'} sprites={sprites} />
      <Text>{slot.task_ref ?? slot.slot_state}</Text>
      {slot.phases.length > 0 ? <PhaseWizard phases={slot.phases} /> : <Text dimColor>{slot.run_state ?? ''}</Text>}
      <Text dimColor>
        age: {formatSeconds(slot.age_seconds)} activity: {formatSeconds(slot.activity_seconds)} heartbeat: {formatSeconds(slot.heartbeat_seconds)}
      </Text>
    </Box>
  );
}

function formatSeconds(value: number | null): string {
  if (value == null) return '--';
  return `${value}s`;
}
