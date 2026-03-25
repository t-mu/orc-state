---
ref: orc-warroom/52-orc-warroom-watch-entrypoint
feature: orc-warroom
priority: normal
status: todo
required_provider: codex
---

# Task 52 — Replace cli/watch.ts with ink entrypoint and non-TTY fallback

Depends on Task 51. Blocks Task 53.

## Scope

**In scope:**
- Replace `cli/watch.ts` with an ink-based entrypoint that renders `<App>`
- Preserve the non-TTY fallback path (plain-text loop) so `cli/watch.test.ts` continues to pass
- Preserve `--once` and `--interval-ms` flag behavior
- Remove the old SIGINT/SIGTERM handlers (ink manages these internally)

**Out of scope:**
- Do not modify `cli/status.ts` or its `--watch` mode (kept as plain-text with Tier 1 colors)
- Do not modify `cli/watch.test.ts`
- Do not modify any component files in `lib/tui/`

---

## Context

### Current state

`cli/watch.ts` is a 54-line plain-text polling loop. `cli/watch.test.ts` spawns it with `--once` and asserts on stdout text like `"Worker Capacity:"`. `cli/orc.ts` (Task 49) already dispatches `watch` via `--import tsx/esm`.

### Desired state

When `process.stdout.isTTY` is true, `orc watch` launches the full-screen ink TUI. When stdout is not a TTY (piped, CI, `watch.test.ts`), it falls back to the old plain-text behavior — identical to the current implementation — so all existing tests continue to pass without modification.

### Start here

- `cli/watch.ts` — current implementation to understand flags, STATE_DIR, signal handlers
- `cli/watch.test.ts` — assertions that the fallback path must satisfy
- `lib/tui/App.tsx` — component to instantiate in TTY path

**Affected files:**
- `cli/watch.ts` — full replacement

---

## Goals

1. Must render the ink `<App>` when `process.stdout.isTTY` is true.
2. Must fall back to plain-text polling loop when `!process.stdout.isTTY` — output must satisfy all `cli/watch.test.ts` assertions unchanged.
3. Must call `preloadSprites()` before `render(<App>)` — sprites must never be loaded inside a component.
4. Must support `--once` flag: in TTY mode, unmount after first render; in fallback mode, render once and exit.
5. Must support `--interval-ms` flag.
6. Must NOT register SIGINT/SIGTERM signal handlers in the TTY path (ink handles these).
7. `cli/watch.test.ts` must pass without any modifications to the test file.

---

## Implementation

### Step 1 — Rewrite `cli/watch.ts`

```typescript
#!/usr/bin/env node
import { join } from 'path';
import { render } from 'ink';
import React from 'react';
import { App } from '../lib/tui/App.js';
import { preloadSprites } from '../lib/tui/sprites.js';
import { buildStatus } from '../lib/statusView.js';
import { colorFormatStatus } from '../lib/colorStatus.js';
import { renderBanner } from '../lib/banner.js';

const args = process.argv.slice(2);
const once = args.includes('--once');
const intervalMsArg = args.find(a => a.startsWith('--interval-ms='));
const intervalMs = intervalMsArg ? parseInt(intervalMsArg.split('=')[1], 10) : 3000;

const STATE_DIR = process.env.ORCH_STATE_DIR ?? join(process.cwd(), '.orc-state');

if (!process.stdout.isTTY) {
  // ── Non-TTY fallback: plain-text loop (preserves watch.test.ts contract) ──
  function render_plain() {
    const status = buildStatus(STATE_DIR);
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(renderBanner());
    console.log(colorFormatStatus(status));
    console.log(`\nwatch interval: ${intervalMs}ms | updated: ${new Date().toISOString()}`);
  }

  render_plain();
  if (once) process.exit(0);

  const timer = setInterval(render_plain, intervalMs);

  process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
  process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
} else {
  // ── TTY path: full-screen ink TUI ──
  const sprites = await preloadSprites();
  const { unmount } = render(
    React.createElement(App, { stateDir: STATE_DIR, sprites, intervalMs })
  );
  if (once) {
    // Give ink one render cycle then exit
    setTimeout(() => { unmount(); process.exit(0); }, 200);
  }
  // ink handles SIGINT/SIGTERM internally — do not register additional handlers
}
```

---

## Acceptance criteria

- [ ] `orc watch` (in a real terminal) opens the full-screen ink TUI with orc sprites.
- [ ] `orc watch --once` (in a real terminal) renders one frame and exits 0.
- [ ] `orc watch --interval-ms=1000` uses the specified interval.
- [ ] `echo "" | orc watch --once` (piped, non-TTY) outputs plain-text status and exits 0.
- [ ] `cli/watch.test.ts` passes without any modification to the test file.
- [ ] `npm test` passes with zero failures.
- [ ] No changes to files outside `cli/watch.ts`.

---

## Tests

No new tests. Verification is through the existing `cli/watch.test.ts` (non-TTY path) and manual smoke testing (TTY path).

---

## Verification

```bash
# TTY smoke test
orc watch --once

# Non-TTY / test path
echo "" | node --import tsx/esm cli/watch.ts --once

# Full test suite
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** The `--once` TTY path uses a 200ms timeout to allow ink one render cycle before unmounting. If ink renders slower than 200ms (unlikely), the output may be blank. Increase timeout if needed.
**Rollback:** restore `cli/watch.ts` from git. No state files touched.
