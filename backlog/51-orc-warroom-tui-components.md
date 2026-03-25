---
ref: orc-warroom/51-orc-warroom-tui-components
feature: orc-warroom
priority: normal
status: done
required_provider: codex
---

# Task 51 — Build core ink TUI component tree

Depends on Tasks 49 and 50. Blocks Task 52.

## Scope

**In scope:**
- Create `lib/tui/App.tsx` — root component, owns polling loop
- Create `lib/tui/Header.tsx` — banner + system summary
- Create `lib/tui/WorkerGrid.tsx` — grid of worker slot panels
- Create `lib/tui/WorkerSlot.tsx` — single slot with sprite, task, elapsed, badge
- Create `lib/tui/OrcSprite.tsx` — frame-cycling sprite renderer
- Create `lib/tui/RunsTable.tsx` — active runs list
- Create `lib/tui/EventFeed.tsx` — recent events panel (polls `readRecentEvents`)
- Create `lib/tui/FailureAlert.tsx` — flashing alert when failures > 0

**Out of scope:**
- Do not wire these components into `cli/watch.ts` yet (that is Task 52)
- Do not add agent output streaming (that is Task 53)
- Do not add keyboard navigation (that is Task 54)

---

## Context

### Current state

No React/ink components exist. `buildStatus()` returns a structured data object; `formatStatus()` renders it as plain text. The TUI needs to display the same information in a persistent full-screen layout with animated orc sprites per worker slot.

### Desired state

A complete component tree under `lib/tui/` that can be instantiated by passing `{ stateDir, sprites, intervalMs }` props to `<App>`. The app polls `buildStatus()` on a timer and re-renders. Each worker slot shows an animated orc sprite whose state tracks the worker's run status.

### Start here

- `lib/statusView.ts` — `buildStatus()` return shape (worker capacity, active runs, recent events, failures)
- `lib/tui/sprites.ts` — `SpriteMap` type
- `lib/eventLog.ts` — `readRecentEvents()` signature

**Affected files:** All files listed under Scope above (new files only).

---

## Goals

1. Must render worker slots equal to `status.workerCapacity.configuredSlots` count.
2. Must map run status to sprite state: `in_progress` → `work`, `done`/`released` → `done`, `blocked`/`failed` → `fail`, empty slot → `idle`.
3. `OrcSprite` must cycle frames at 500ms interval using `setInterval` + `useState`.
4. `EventFeed` must poll `readRecentEvents(eventsPath, 20)` every 3s (NOT tail a file).
5. `App` must poll `buildStatus()` every `intervalMs` ms (default 3000).
6. Must handle `stateDir` pointing to a non-existent or empty directory without crashing.
7. `npm test` must pass — no existing tests broken.

---

## Implementation

### Step 1 — `lib/tui/App.tsx`

Root component. Owns the polling timer. Passes status data to children as props.

```tsx
import React, { useState, useEffect } from 'react';
import { Box } from 'ink';
import { buildStatus } from '../statusView.js';
import { SpriteMap } from './sprites.js';
import { Header } from './Header.js';
import { WorkerGrid } from './WorkerGrid.js';
import { RunsTable } from './RunsTable.js';
import { EventFeed } from './EventFeed.js';
import { FailureAlert } from './FailureAlert.js';

interface AppProps {
  stateDir: string;
  sprites: SpriteMap;
  intervalMs?: number;
}

export function App({ stateDir, sprites, intervalMs = 3000 }: AppProps) {
  const [status, setStatus] = useState(() => buildStatus(stateDir));

  useEffect(() => {
    const id = setInterval(() => setStatus(buildStatus(stateDir)), intervalMs);
    return () => clearInterval(id);
  }, [stateDir, intervalMs]);

  return (
    <Box flexDirection="column">
      <Header status={status} />
      <FailureAlert failures={status.recentFailures} />
      <WorkerGrid status={status} sprites={sprites} />
      <RunsTable runs={status.activeRuns} />
      <EventFeed stateDir={stateDir} />
    </Box>
  );
}
```

### Step 2 — `lib/tui/Header.tsx`

Renders the figlet banner (from `renderBanner()`) and a one-line summary.

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import { renderBanner } from '../banner.js';

export function Header({ status }: { status: any }) {
  const cap = status.workerCapacity ?? {};
  return (
    <Box flexDirection="column">
      <Text>{renderBanner()}</Text>
      <Text dimColor>
        slots: {cap.usedSlots ?? 0}/{cap.configuredSlots ?? 0}
        {' | '}tasks: {status.taskCounts?.todo ?? 0} todo
        {' | '}{new Date().toISOString()}
      </Text>
    </Box>
  );
}
```

### Step 3 — `lib/tui/OrcSprite.tsx`

Cycles pre-loaded frame strings at 500ms.

```tsx
import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import { SpriteMap } from './sprites.js';

type SpriteState = 'idle' | 'work' | 'done' | 'fail';

export function OrcSprite({ spriteState, sprites }: { spriteState: SpriteState; sprites: SpriteMap }) {
  const frames = sprites.get(spriteState) ?? sprites.get('idle') ?? ['?'];
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setIdx(i => (i + 1) % frames.length), 500);
    return () => clearInterval(id);
  }, [frames.length]);

  return <Text>{frames[idx]}</Text>;
}
```

### Step 4 — `lib/tui/WorkerSlot.tsx`

Single slot panel.

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import { OrcSprite } from './OrcSprite.js';
import { SpriteMap } from './sprites.js';

function runStatusToSpriteState(status?: string) {
  if (!status) return 'idle' as const;
  if (status === 'in_progress' || status === 'claimed') return 'work' as const;
  if (status === 'done' || status === 'released') return 'done' as const;
  return 'fail' as const;
}

export function WorkerSlot({ slotId, run, sprites }: { slotId: string; run?: any; sprites: SpriteMap }) {
  const spriteState = runStatusToSpriteState(run?.status);
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} width={24}>
      <Text bold>{slotId}</Text>
      <OrcSprite spriteState={spriteState} sprites={sprites} />
      <Text wrap="truncate">{run?.taskRef ?? '—'}</Text>
      <Text dimColor>{run?.status ?? 'idle'}</Text>
    </Box>
  );
}
```

### Step 5 — `lib/tui/WorkerGrid.tsx`

Renders all configured slots as a row of WorkerSlot panels.

### Step 6 — `lib/tui/RunsTable.tsx`

Renders `status.activeRuns` as a compact table using ink `<Box>` rows.

### Step 7 — `lib/tui/EventFeed.tsx`

Polls `readRecentEvents` from `lib/eventLog.ts` on a 3s timer. Does NOT tail files.

```tsx
import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { join } from 'path';
import { readRecentEvents } from '../eventLog.js';

export function EventFeed({ stateDir }: { stateDir: string }) {
  const eventsPath = join(stateDir, 'events.db');
  const [events, setEvents] = useState<any[]>([]);

  useEffect(() => {
    const load = () => {
      try { setEvents(readRecentEvents(eventsPath, 10)); } catch { /* db not ready */ }
    };
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [eventsPath]);

  return (
    <Box flexDirection="column">
      <Text bold cyan>Recent Events</Text>
      {events.slice(0, 10).map((e, i) => (
        <Text key={i} dimColor>{e.event_type} — {e.run_id ?? ''}</Text>
      ))}
    </Box>
  );
}
```

### Step 8 — `lib/tui/FailureAlert.tsx`

Renders a red flashing alert when `failures.length > 0`. Use ink's `<Text color="red">`.

---

## Acceptance criteria

- [ ] `App` renders without crashing when `stateDir` points to a non-existent directory.
- [ ] `OrcSprite` cycles through all frames of its current state without error.
- [ ] Worker slots equal the configured slot count from `buildStatus()`.
- [ ] `EventFeed` polls the SQLite DB — no `fs.watch` or file-tail anywhere in the component.
- [ ] `npm test` passes with zero failures.
- [ ] No changes to files outside `lib/tui/`.

---

## Tests

Add `lib/tui/App.test.tsx` (render smoke test using ink's `render` + `lastFrame()`):

```tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { App } from './App.js';

describe('App', () => {
  it('renders without crashing with empty state dir', async () => {
    const sprites = new Map([['idle', ['O']], ['work', ['O']], ['done', ['O']], ['fail', ['X']]]);
    const { lastFrame } = render(<App stateDir="/tmp/nonexistent-orc" sprites={sprites} />);
    expect(lastFrame()).toBeTruthy();
  });
});
```

Add `ink-testing-library` to devDependencies (pin exact version).

---

## Verification

```bash
npx vitest run lib/tui/
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** ink rendering in vitest requires `ink-testing-library`; this adds a devDependency.
**Rollback:** delete `lib/tui/` directory. No state files touched.
