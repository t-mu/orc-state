---
ref: orc-warroom/51-orc-warroom-tui-components
feature: orc-warroom
priority: normal
status: done
required_provider: codex
---

# Task 51 — Build core Ink TUI component tree

Depends on Tasks 49 and 50. Blocks Task 52.

## Scope

**In scope:**
- Create `lib/tui/App.tsx` — root component, owns polling loop
- Create `lib/tui/Header.tsx` — banner + system summary
- Create `lib/tui/WorkerGrid.tsx` — grid of worker slot panels
- Create `lib/tui/WorkerSlot.tsx` — single slot with sprite, task, elapsed, badge
- Create `lib/tui/OrcSprite.tsx` — frame-cycling sprite renderer
- Create `lib/tui/RunsTable.tsx` — active runs list
- Create `lib/tui/EventFeed.tsx` — recent events panel
- Create `lib/tui/FailureAlert.tsx` — flashing alert when failures > 0
- Small supporting changes outside `lib/tui/` are allowed only if required for test setup, safe empty-state fallback, or dependency hygiene

**Out of scope:**
- Do not wire these components into `cli/watch.ts` yet (that is Task 52)
- Do not add agent output streaming (that is Task 53)
- Do not add keyboard navigation (that is Task 54)

---

## Context

### Current state

No React/Ink components exist. `buildStatus()` returns a structured data object; `formatStatus()` renders it as plain text. The TUI needs to display the same information in a persistent full-screen layout with animated orc sprites per worker slot.

The current `buildStatus()` shape uses these keys:
- `worker_capacity.configured_slots`, `worker_capacity.used_slots`, `worker_capacity.available_slots`, `worker_capacity.slots`
- `tasks.counts`
- `claims.active`
- `failures.startup`, `failures.lifecycle`
- `recentEvents`
- `eventReadError`

The sprite source is text-grid frame data from `lib/tui/sprites.ts`, not PNG-derived terminal-image output.

### Desired state

A complete component tree under `lib/tui/` that can be instantiated by passing `{ stateDir, sprites, intervalMs }` props to `<App>`. The app polls `buildStatus()` on a timer and re-renders. Each worker slot shows an animated orc sprite whose state tracks the worker's run status.

The TUI must have a safe fallback when `stateDir` does not exist or runtime state files are missing. It should render a valid empty state instead of throwing during initial render.

### Start here

- `lib/statusView.ts` — authoritative `buildStatus()` return shape
- `lib/tui/sprites.ts` — `SpriteMap` type
- `package.json` / `package-lock.json` — only if dependency cleanup is needed

**Affected files:** primary changes under `lib/tui/`; small support changes outside it are allowed only when necessary.

---

## Goals

1. Must render worker slots equal to `status.worker_capacity.configured_slots` count.
2. Must map run status to sprite state: `in_progress` and `claimed` → `work`, `done`/`released` → `done`, `blocked`/`failed` → `fail`, empty slot → `idle`.
3. `OrcSprite` must cycle frames at 500ms interval using `setInterval` + `useState`.
4. `EventFeed` must render from `status.recentEvents` and `status.eventReadError`. Do not add a second polling loop or any file-tail path.
5. `App` must poll `buildStatus()` every `intervalMs` ms (default 3000).
6. Must handle `stateDir` pointing to a non-existent or empty directory without crashing.
7. `npm test` must pass — no existing tests broken.
8. `WorkerGrid` must wrap slot panels when terminal width is insufficient.

---

## Implementation

### Step 1 — `lib/tui/App.tsx`

Root component. Owns the polling timer. Passes status data to children as props. Do not initialize state with a raw `buildStatus(stateDir)` call unless it is wrapped in a safe fallback.

### Step 2 — `lib/tui/Header.tsx`

Renders the figlet banner (from `renderBanner()`) and a one-line summary. Use the real `buildStatus()` keys, not the older camelCase examples.

### Step 3 — `lib/tui/OrcSprite.tsx`

Cycles pre-rendered text sprite frames at 500ms.

### Step 4 — `lib/tui/WorkerSlot.tsx`

Single slot panel. `worker_capacity.slots` does not contain the full claim state, so any run-state mapping must derive from `claims.active` or a local view-model adapter.

### Step 5 — `lib/tui/WorkerGrid.tsx`

Renders all configured slots as a wrapping row grid of `WorkerSlot` panels.

### Step 6 — `lib/tui/RunsTable.tsx`

Renders `status.claims.active` as a compact table using Ink `<Box>` rows.

### Step 7 — `lib/tui/EventFeed.tsx`

Renders `status.recentEvents` and `status.eventReadError` from `App` state. Does NOT poll independently and does NOT tail files.

### Step 8 — `lib/tui/FailureAlert.tsx`

Renders a red alert when failures are present.

---

## Acceptance criteria

- [ ] `App` renders without crashing when `stateDir` points to a non-existent directory.
- [ ] `OrcSprite` cycles through all frames of its current state without error.
- [ ] Worker slots equal the configured slot count from `buildStatus()`.
- [ ] `EventFeed` uses `status.recentEvents` / `status.eventReadError` from the app state — no duplicate polling loop, no `fs.watch`, no file-tail path.
- [ ] Worker grid wraps slot panels when width is constrained.
- [ ] `npm test` passes with zero failures.
- [ ] No unnecessary changes outside the allowed scope.

---

## Tests

Add `lib/tui/App.test.tsx` (render smoke test using `ink-testing-library` `render` + `lastFrame()`).

Add `lib/tui/OrcSprite.test.tsx` to assert frame cycling.
