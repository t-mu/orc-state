import { Box, Text } from 'ink';
import type { SlotDetail } from './layout.ts';
import { OrcSprite } from './OrcSprite.tsx';
import { PhaseWizard } from './PhaseWizard.tsx';
import type { SpriteMap } from './sprites.ts';
import type { PhaseEntry, WorkerSlotViewModel } from './status.ts';

/**
 * One worker box. Every line is one terminal row (long text is truncated) so
 * `slotHeight` in layout.ts can budget it: `compact` drops the sprite,
 * `minimal` also shows only the current phase.
 */
export function WorkerSlot({ slot, sprites, detail = 'full' }: { slot: WorkerSlotViewModel; sprites: SpriteMap; detail?: SlotDetail }) {
  const roleColor = slot.role === 'reviewer' ? 'magenta' : 'green';
  const borderColor = slot.waiting_input ? 'yellow' : roleColor;
  const providerLabel = slot.provider ?? 'unknown';
  const modelLabel = slot.model ? ` ${slot.model}` : '';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} flexGrow={1} flexBasis={36} width={36} marginRight={1} marginBottom={1}>
      <Text bold wrap="truncate">
        {slot.slot_id}
        {' '}
        <Text color={roleColor}>[{slot.role.toUpperCase()}]</Text>
      </Text>
      <Text dimColor wrap="truncate">{providerLabel}{modelLabel}</Text>
      {detail === 'full' ? <OrcSprite spriteState={slot.sprite_state} role="worker" sprites={sprites} /> : null}
      <Text wrap="truncate">{slot.task_ref ?? slot.slot_state}</Text>
      {slot.waiting_input ? <WaitingInput waiting={slot.waiting_input} /> : null}
      {detail === 'minimal'
        ? <MinimalPhase slot={slot} />
        : slot.phases.length > 0 ? <PhaseWizard phases={slot.phases} activity={slot.current_activity} /> : <Text dimColor>{slot.run_state ?? ''}</Text>}
      <Text dimColor wrap="truncate">
        age: {formatSeconds(slot.age_seconds)} activity: {formatSeconds(slot.activity_seconds)}
      </Text>
      <Text dimColor wrap="truncate">heartbeat: {formatSeconds(slot.heartbeat_seconds)}</Text>
    </Box>
  );
}

/** Two rows: the NEEDS INPUT badge with the wait time, then the question. */
function WaitingInput({ waiting }: { waiting: NonNullable<WorkerSlotViewModel['waiting_input']> }) {
  return (
    <>
      <Text wrap="truncate">
        <Text bold inverse color="yellow">{' NEEDS INPUT '}</Text>
        <Text color="yellow">{` waiting ${formatSeconds(waiting.waiting_seconds)}`}</Text>
      </Text>
      <Text color="yellow" wrap="truncate">? {waiting.question ?? '(question unavailable)'}</Text>
    </>
  );
}

/** One row: the phase in progress (or the last one reached), else the run state. */
function MinimalPhase({ slot }: { slot: WorkerSlotViewModel }) {
  const current = currentPhase(slot.phases);
  if (!current) return <Text dimColor wrap="truncate">{slot.run_state ?? ' '}</Text>;
  return <PhaseWizard phases={[current]} activity={null} />;
}

function currentPhase(phases: PhaseEntry[]): PhaseEntry | null {
  return phases.find(p => p.state !== 'done' && p.state !== 'pending')
    ?? [...phases].reverse().find(p => p.state === 'done')
    ?? null;
}

function formatSeconds(value: number | null): string {
  if (value == null) return '--';
  return `${value}s`;
}
