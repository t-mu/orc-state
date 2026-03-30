---
ref: agent-lens/54-agent-lens-keyboard-nav
feature: agent-lens
priority: normal
status: done
required_provider: codex
---

# Task 54 — Add keyboard navigation to the TUI

Depends on Task 53.

## Scope

**In scope:**
- Add `useInput` keyboard handler in `lib/tui/App.tsx`
- `Tab` cycles focus between worker slots
- `↑` / `↓` scrolls the focused slot's `AgentOutputPanel` output
- `q` quits the TUI cleanly
- Highlight the focused slot with a distinct border style

**Out of scope:**
- Do not add mouse support
- Do not add any new dependencies
- Do not change the data polling or sprite animation logic

---

## Context

### Current state

The TUI renders all worker slots but there is no interactivity. `AgentOutputPanel` shows only the last 3 lines. Users cannot scroll to see earlier output.

### Desired state

Users can `Tab` between worker slots and use `↑`/`↓` to scroll each slot's output panel. The focused slot has a highlighted border. `q` exits. All navigation uses ink's built-in `useInput` hook — no new libraries.

### Start here

- `lib/tui/App.tsx` — where to add `useInput`
- `lib/tui/WorkerSlot.tsx` — where to add focus highlight
- `lib/tui/AgentOutputPanel.tsx` — where to add scroll offset prop

**Affected files:**
- `lib/tui/App.tsx` — add `useInput`, focused slot state
- `lib/tui/WorkerSlot.tsx` — accept `focused` prop, change border color
- `lib/tui/AgentOutputPanel.tsx` — accept `scrollOffset` prop, apply to visible window

---

## Goals

1. Must use ink's `useInput` hook — no new input libraries.
2. `Tab` must cycle focus through all configured worker slots (wrapping).
3. `↑` / `↓` must scroll the focused slot's output by one line per keypress.
4. `q` must call `process.exit(0)` cleanly.
5. Focused slot must have a visually distinct border (e.g. `borderColor="cyan"` vs default).
6. Scroll state is per-slot (scrolling slot 1 does not affect slot 2's position).
7. `npm test` must pass with zero failures.

---

## Implementation

### Step 1 — Update `lib/tui/App.tsx`

Add focused slot index and per-slot scroll offsets to state:

```tsx
const [focusedIdx, setFocusedIdx] = useState(0);
const [scrollOffsets, setScrollOffsets] = useState<Record<number, number>>({});

useInput((input, key) => {
  if (input === 'q') { process.exit(0); }
  if (key.tab) {
    setFocusedIdx(i => (i + 1) % slotCount);
  }
  if (key.upArrow) {
    setScrollOffsets(o => ({ ...o, [focusedIdx]: Math.max(0, (o[focusedIdx] ?? 0) - 1) }));
  }
  if (key.downArrow) {
    setScrollOffsets(o => ({ ...o, [focusedIdx]: (o[focusedIdx] ?? 0) + 1 }));
  }
});
```

Pass `focused` and `scrollOffset` props to each `WorkerSlot`.

### Step 2 — Update `lib/tui/WorkerSlot.tsx`

Accept `focused: boolean` prop. When focused, use `borderColor="cyan"`:

```tsx
<Box borderStyle="round" borderColor={focused ? 'cyan' : undefined} ...>
```

Pass `scrollOffset` down to `AgentOutputPanel`.

### Step 3 — Update `lib/tui/AgentOutputPanel.tsx`

Accept `scrollOffset: number` prop (default 0). Apply to the visible window:

```tsx
const visible = lines.slice(
  Math.max(0, lines.length - VISIBLE_LINES - scrollOffset),
  Math.max(VISIBLE_LINES, lines.length - scrollOffset)
);
```

---

## Acceptance criteria

- [ ] `Tab` cycles focus through slots; focused slot border turns cyan.
- [ ] `↑` / `↓` scrolls only the focused slot's output panel.
- [ ] `q` exits the TUI with code 0.
- [ ] Scroll state is independent per slot.
- [ ] No new dependencies added.
- [ ] `npm test` passes with zero failures.
- [ ] No changes to files outside the three listed components.

---

## Tests

No new automated tests — keyboard interaction requires a real TTY. Manual smoke test is sufficient.

---

## Verification

```bash
# Manual: run orc watch in a terminal, press Tab, ↑, ↓, q
orc watch

nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** `useInput` only fires when ink's app has focus. In some terminal multiplexers (tmux, screen) input handling may behave unexpectedly.
**Rollback:** revert the three changed files. No state files touched.
