---
ref: agent-lens/53-agent-lens-pty-output-panel
feature: agent-lens
priority: normal
status: todo
required_provider: codex
---

# Task 53 — Stream live worker PTY output into TUI worker slot panels

Depends on Task 52. Blocks Task 54.

## Scope

**In scope:**
- Create `lib/tui/ptyLog.ts` — helper that resolves the PTY log path for an agent
- Create `lib/tui/AgentOutputPanel.tsx` — component that tails a PTY log and renders the last N lines
- Extend `lib/tui/WorkerSlot.tsx` to render `<AgentOutputPanel>` for slots with active runs

**Out of scope:**
- Do not add keyboard navigation (that is Task 54)
- Do not add `strip-ansi` as a new dependency — PTY logs are already ANSI-sanitized by `adapters/pty.ts`; use the existing transitive `strip-ansi@6.0.1` only if raw bytes need secondary cleaning
- Do not modify any other component files

---

## Context

### Current state

Worker slots show sprite + task ref + status but no live output. Worker agents write sanitized PTY output to `STATE_DIR/pty-logs/{agentId}.log` (established in `adapters/pty.ts` line 49). This data exists on disk but is not surfaced in the TUI.

### Desired state

Each worker slot with an active run shows the last 3 lines of its PTY log below the sprite. The panel tails the log file by tracking file position and polling for new bytes every second. If no log exists (non-PTY provider or slot is idle), a placeholder is shown instead.

### Start here

- `adapters/pty.ts` — confirms log path convention: `STATE_DIR/pty-logs/{agentId}.log`
- `lib/tui/WorkerSlot.tsx` — where to integrate the panel
- `lib/tui/App.tsx` — how `stateDir` is passed through the component tree

**Affected files:**
- `lib/tui/ptyLog.ts` — new file
- `lib/tui/AgentOutputPanel.tsx` — new file
- `lib/tui/WorkerSlot.tsx` — extend to include output panel

---

## Goals

1. Must create `lib/tui/ptyLog.ts` exporting `ptyLogPath(stateDir, agentId): string`.
2. Must create `lib/tui/AgentOutputPanel.tsx` that polls a PTY log file and renders last 3 lines.
3. Must handle missing log file gracefully — render a dim placeholder, not an error.
4. Must handle non-PTY-provider slots (no log file) identically to idle slots.
5. `AgentOutputPanel` must NOT use `strip-ansi` as a new direct dependency — PTY logs are pre-sanitized.
6. Must not break any existing tests — `npm test` passes.
7. Must not change the external behavior of any existing CLI command.

---

## Implementation

### Step 1 — Create `lib/tui/ptyLog.ts`

```typescript
import { join } from 'path';

export function ptyLogPath(stateDir: string, agentId: string): string {
  return join(stateDir, 'pty-logs', `${agentId}.log`);
}
```

### Step 2 — Create `lib/tui/AgentOutputPanel.tsx`

Uses a `setInterval` tail loop: reads file size, seeks to last-known position, reads new bytes.

```tsx
import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { open, FileHandle } from 'fs/promises';
import { ptyLogPath } from './ptyLog.js';

const MAX_LINES = 30;
const VISIBLE_LINES = 3;

interface Props {
  stateDir: string;
  agentId: string;
}

export function AgentOutputPanel({ stateDir, agentId }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [missing, setMissing] = useState(false);
  const posRef = useRef(0);
  const logPath = ptyLogPath(stateDir, agentId);

  useEffect(() => {
    let fh: FileHandle | null = null;
    let timer: ReturnType<typeof setInterval>;

    async function tail() {
      try {
        if (!fh) fh = await open(logPath, 'r');
        const stat = await fh.stat();
        if (stat.size <= posRef.current) return;
        const buf = Buffer.alloc(stat.size - posRef.current);
        await fh.read(buf, 0, buf.length, posRef.current);
        posRef.current = stat.size;
        const newLines = buf.toString('utf8').split('\n').filter(Boolean);
        setLines(prev => [...prev, ...newLines].slice(-MAX_LINES));
        setMissing(false);
      } catch {
        setMissing(true);
      }
    }

    tail();
    timer = setInterval(tail, 1000);
    return () => {
      clearInterval(timer);
      fh?.close().catch(() => {});
    };
  }, [logPath]);

  if (missing) {
    return <Text dimColor>  no output log</Text>;
  }

  const visible = lines.slice(-VISIBLE_LINES);
  return (
    <Box flexDirection="column">
      {visible.map((line, i) => (
        <Text key={i} dimColor wrap="truncate">  {line}</Text>
      ))}
    </Box>
  );
}
```

### Step 3 — Extend `lib/tui/WorkerSlot.tsx`

Add `stateDir` prop. When `run` is defined and has an `agentId`, render `<AgentOutputPanel>` below the sprite:

```tsx
{run?.agentId && (
  <AgentOutputPanel stateDir={stateDir} agentId={run.agentId} />
)}
```

Update `WorkerGrid.tsx` to pass `stateDir` down to `WorkerSlot`.

---

## Acceptance criteria

- [ ] `ptyLogPath('dir', 'orc-1')` returns `'dir/pty-logs/orc-1.log'`.
- [ ] When an active run has a PTY log, `AgentOutputPanel` renders the last 3 lines of output.
- [ ] When the log file does not exist, `AgentOutputPanel` renders `"no output log"` placeholder.
- [ ] Idle slots (no active run) do not render `AgentOutputPanel` at all.
- [ ] `npm test` passes with zero failures.
- [ ] No new direct dependencies added.

---

## Tests

Add to `lib/tui/ptyLog.test.ts` (new file):

```typescript
import { describe, it, expect } from 'vitest';
import { ptyLogPath } from './ptyLog.js';

describe('ptyLogPath', () => {
  it('constructs the correct path', () => {
    expect(ptyLogPath('/state', 'orc-1')).toBe('/state/pty-logs/orc-1.log');
  });
});
```

---

## Verification

```bash
npx vitest run lib/tui/ptyLog.test.ts
```

```bash
# With active workers running:
orc watch   # active slots should show last 3 lines of worker output

nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** High-volume PTY log output may cause rapid re-renders. The 1s poll interval and MAX_LINES=30 cap mitigate this.
**Rollback:** delete `lib/tui/ptyLog.ts` and `lib/tui/AgentOutputPanel.tsx`; revert `lib/tui/WorkerSlot.tsx` and `WorkerGrid.tsx`. No state files touched.
