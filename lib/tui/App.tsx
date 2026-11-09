import { Box, useStdout } from 'ink';
import { startTransition, useEffect, useMemo, useState } from 'react';
import { renderBanner } from '../banner.ts';
import type { SpriteMap } from './sprites.ts';
import { EventFeed } from './EventFeed.tsx';
import { FailureAlert } from './FailureAlert.tsx';
import { Header } from './Header.tsx';
import { computeLayout, measureBlock } from './layout.ts';
import { RunsTable } from './RunsTable.tsx';
import { ScoutList } from './ScoutList.tsx';
import { buildWorkerSlotViewModels, loadTuiStatus, type WorkerSlotViewModel } from './status.ts';
import { WorkerGrid } from './WorkerGrid.tsx';

export interface AppProps {
  stateDir: string;
  sprites: SpriteMap;
  intervalMs?: number;
}

function loadSnapshot(stateDir: string) {
  return { status: loadTuiStatus(stateDir), loadedAt: new Date().toISOString() };
}

/** Terminal size, updated on `resize`. Undefined rows (no TTY) disables the height budget. */
function useTerminalSize(): { rows: number | undefined; columns: number | undefined } {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({ rows: stdout.rows, columns: stdout.columns }));

  useEffect(() => {
    const onResize = () => setSize({ rows: stdout.rows, columns: stdout.columns });
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return size;
}

function phaseLines(slot: WorkerSlotViewModel): number {
  if (slot.phases.length === 0) return slot.run_state ? 1 : 0;
  const hasActivityRow = slot.current_activity != null && slot.phases.some(p => p.state === 'active' || p.state === 'stale');
  return slot.phases.length + (hasActivityRow ? 1 : 0);
}

function spriteLines(sprites: SpriteMap): number {
  let max = 1;
  for (const frames of sprites.values()) {
    for (const frame of frames) max = Math.max(max, frame.split('\n').length);
  }
  return max;
}

export function App({ stateDir, sprites, intervalMs = 3000 }: AppProps) {
  const [snapshot, setSnapshot] = useState(() => loadSnapshot(stateDir));
  const { rows, columns } = useTerminalSize();
  const banner = useMemo(() => renderBanner(), []);
  const bannerSize = useMemo(() => measureBlock(banner), [banner]);
  const spriteHeight = useMemo(() => spriteLines(sprites), [sprites]);

  useEffect(() => {
    const refresh = () => {
      startTransition(() => {
        setSnapshot(loadSnapshot(stateDir));
      });
    };

    refresh();
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, stateDir]);

  const { status, loadedAt } = snapshot;
  const workerSlots = buildWorkerSlotViewModels(status);
  const scouts = status.scouts ?? [];
  const failureCount = status.failures.startup.length + status.failures.lifecycle.length;

  const layout = computeLayout({
    rows,
    columns,
    bannerLines: bannerSize.lines,
    bannerWidth: bannerSize.width,
    spriteLines: spriteHeight,
    hasFailures: failureCount > 0,
    slots: workerSlots.map(slot => ({ phaseLines: phaseLines(slot) })),
    scoutCount: scouts.length,
    runCount: status.claims.active.length,
    eventCount: status.recentEvents.length,
    hasEventError: Boolean(status.eventReadError),
  });

  return (
    <Box flexDirection="column">
      <Header status={status} banner={layout.showBanner ? banner : null} updatedAt={loadedAt} />
      <FailureAlert failures={status.failures} />
      <WorkerGrid
        slots={workerSlots}
        sprites={sprites}
        detail={layout.slotDetail}
        capacity={{
          configured: status.worker_capacity.configured_slots,
          used: status.worker_capacity.used_slots,
          available: status.worker_capacity.available_slots,
        }}
      />
      <ScoutList scouts={scouts} maxLines={layout.maxScoutLines} />
      <RunsTable runs={status.claims.active} maxLines={layout.maxRunLines} />
      <EventFeed events={status.recentEvents} eventReadError={status.eventReadError} maxLines={layout.maxEventLines} />
    </Box>
  );
}
