---
ref: terminal-polish/48-terminal-polish-apply-to-cli
feature: terminal-polish
priority: normal
status: todo
---

# Task 48 — Wire banner and colors into status and watch CLI commands

Depends on Task 47. Blocks nothing.

## Scope

**In scope:**
- Update `cli/status.ts` to use `colorFormatStatus` / `colorFormatAgentStatus` and print the figlet banner
- Update `cli/watch.ts` to use `colorFormatStatus` and print the banner inside the render loop
- `--json` output path in `status.ts` must remain ANSI-free

**Out of scope:**
- Do not modify `lib/statusView.ts`, `lib/colorStatus.ts`, or `lib/banner.ts`
- Do not touch any test files beyond updating assertions that check exact watch output
- Do not change CLI flag parsing or exit codes

---

## Context

### Current state

`cli/status.ts` calls `formatStatus()` directly and prints the result via `console.log`. `cli/watch.ts` clears the screen and calls `formatStatus()` on each tick. Neither prints a banner nor uses colors.

### Desired state

Both CLIs use `colorFormatStatus()` for colored plain-text output and prepend `renderBanner()`. The `--json` path in `status.ts` is untouched. `watch.ts` prints the banner inside `render()` so it survives screen clears. The non-TTY path in `watch.ts` is unchanged (chalk auto-disables ANSI when stdout is not a TTY).

### Start here

- `cli/status.ts` — current render paths (single-shot, `--watch`, `--mine`, `--json`)
- `cli/watch.ts` — current `render()` function and polling loop
- `cli/watch.test.ts` — assertions on stdout that must still pass

**Affected files:**
- `cli/status.ts`
- `cli/watch.ts`

---

## Goals

1. Must display `renderBanner()` output before status content in `orc status` (single-shot and `--watch` mode).
2. Must display `renderBanner()` output as the first line inside `render()` in `orc watch` (so it persists through screen clears).
3. Must use `colorFormatStatus()` instead of `formatStatus()` in all plain-text output paths.
4. Must use `colorFormatAgentStatus()` instead of `formatAgentStatus()` in `--mine` output path.
5. Must NOT inject ANSI into `--json` output path.
6. Must NOT register duplicate signal handlers — `watch.ts` already has SIGINT/SIGTERM; leave them as-is.
7. `cli/watch.test.ts` must pass — the non-TTY path through `watch.ts` produces plain-text output (chalk disables at level 0 when stdout is not a TTY).

---

## Implementation

### Step 1 — Update `cli/status.ts`

Import the new modules:
```typescript
import { renderBanner } from '../lib/banner.js';
import { colorFormatStatus, colorFormatAgentStatus } from '../lib/colorStatus.js';
```

In the single-shot plain-text path, replace:
```typescript
console.log(formatStatus(status));
```
with:
```typescript
console.log(renderBanner());
console.log(colorFormatStatus(status));
```

In the `--mine` path, replace `formatAgentStatus(...)` with `colorFormatAgentStatus(...)`.

In the `--watch` render loop in `status.ts`, print banner once before the loop starts (not inside `render()` — `status.ts --watch` does not clear the screen):
```typescript
console.log(renderBanner());
// then the setInterval loop follows
```

The `--json` path is untouched — it calls `JSON.stringify(...)` directly, never `formatStatus`.

### Step 2 — Update `cli/watch.ts`

Import the new modules:
```typescript
import { renderBanner } from '../lib/banner.js';
import { colorFormatStatus } from '../lib/colorStatus.js';
```

Move banner inside `render()` so it is printed after the screen-clear on each tick:
```typescript
function render() {
  const status = buildStatus(STATE_DIR);
  process.stdout.write('\x1b[2J\x1b[H');
  console.log(renderBanner());
  console.log(colorFormatStatus(status));
  console.log(`\nupdated at: ${new Date().toISOString()} | interval: ${intervalMs}ms`);
}
```

Do not change SIGINT/SIGTERM handlers, interval logic, `--once` flag, or `--interval-ms` flag.

---

## Acceptance criteria

- [ ] `orc status` displays the figlet ORC-STATE banner followed by colored status output.
- [ ] `orc status --json` produces clean JSON with no ANSI escape codes.
- [ ] `orc status --watch` displays the banner once, then refreshes colored status on each tick.
- [ ] `orc status --mine --agent-id=<id>` displays colored agent status.
- [ ] `orc watch` displays the banner + colored status on every screen refresh.
- [ ] `orc watch --once` exits 0 and produces output (banner + status) — compatible with existing test.
- [ ] `cli/watch.test.ts` passes without modification to the test file.
- [ ] `npm test` passes with zero failures.
- [ ] No changes to files outside the stated scope.

---

## Tests

No new tests required. Verify existing `cli/watch.test.ts` continues to pass — the non-TTY detection in chalk causes ANSI codes to be omitted when stdout is piped (as in tests), so `.toContain('Worker Capacity:')` etc. still match.

---

## Verification

```bash
orc status
orc status --json | jq .
orc watch --once
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** chalk TTY detection may behave differently in some CI environments, causing colors to appear in `--json` output if stdout is a TTY there. The `--json` path never calls `formatStatus()` so this cannot happen.
**Rollback:** revert `cli/status.ts` and `cli/watch.ts`. No state files touched.
