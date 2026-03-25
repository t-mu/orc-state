import { Box } from 'ink';
import { startTransition, useEffect, useState } from 'react';
import type { SpriteMap } from './sprites.ts';
import { EventFeed } from './EventFeed.tsx';
import { FailureAlert } from './FailureAlert.tsx';
import { Header } from './Header.tsx';
import { RunsTable } from './RunsTable.tsx';
import { buildWorkerSlotViewModels, loadTuiStatus } from './status.ts';
import { WorkerGrid } from './WorkerGrid.tsx';

export interface AppProps {
  stateDir: string;
  sprites: SpriteMap;
  intervalMs?: number;
}

export function App({ stateDir, sprites, intervalMs = 3000 }: AppProps) {
  const [status, setStatus] = useState(() => loadTuiStatus(stateDir));

  useEffect(() => {
    const refresh = () => {
      startTransition(() => {
        setStatus(loadTuiStatus(stateDir));
      });
    };

    refresh();
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, stateDir]);

  const workerSlots = buildWorkerSlotViewModels(status);

  return (
    <Box flexDirection="column">
      <Header status={status} />
      <FailureAlert failures={status.failures} />
      <WorkerGrid slots={workerSlots} sprites={sprites} />
      <RunsTable runs={status.claims.active} />
      <EventFeed events={status.recentEvents} eventReadError={status.eventReadError} />
    </Box>
  );
}
