---
ref: terminal-polish/47-terminal-polish-deps-and-color-layer
feature: terminal-polish
priority: normal
status: done
---

# Task 47 — Add color library deps and create CLI color layer

Independent.

## Scope

**In scope:**
- Add `chalk@5.4.1`, `figlet@1.8.0`, `boxen@8.0.1` to `dependencies` in `package.json` (exact pins, no `^`/`~`)
- Add `@types/figlet@1.7.0` to `devDependencies`
- Create `lib/banner.ts` — exports `renderBanner(): string`
- Create `lib/colorStatus.ts` — exports `colorFormatStatus()` and `colorFormatAgentStatus()` as chalk wrappers over the plain-text functions

**Out of scope:**
- Do not modify `lib/statusView.ts` — `formatStatus()` and `formatAgentStatus()` must stay plain-string
- Do not wire banner or colors into any CLI files yet (that is Task 48)
- Do not modify any test files

---

## Context

### Current state

`orc status` and `orc watch` produce plain monochrome text. No styling libraries exist in the project. `lib/statusView.ts` owns all formatting; its output is tested with `.toContain()` assertions on raw string literals. Injecting ANSI codes into `formatStatus()` directly would break these tests.

### Desired state

A new `lib/colorStatus.ts` module wraps `formatStatus()` and `formatAgentStatus()` output with chalk colors at the CLI layer only. `lib/statusView.ts` is never touched. A `lib/banner.ts` module produces the figlet ASCII banner. Both modules are pure functions with no side effects.

### Start here

- `lib/statusView.ts` — understand `formatStatus()` and `formatAgentStatus()` signatures and output structure
- `lib/statusView.test.ts` — confirm existing `.toContain()` assertions that must not break
- `package.json` — current dependencies (no UI libs)

**Affected files:**
- `package.json` — add chalk, figlet, boxen, @types/figlet
- `lib/banner.ts` — new file
- `lib/colorStatus.ts` — new file

---

## Goals

1. Must add chalk@5.4.1, figlet@1.8.0, boxen@8.0.1, @types/figlet@1.7.0 with exact pinned versions.
2. Must create `lib/banner.ts` exporting `renderBanner(): string` using figlet Doom font + chalk.green.
3. Must create `lib/colorStatus.ts` exporting `colorFormatStatus(status): string` and `colorFormatAgentStatus(status, agentId): string`.
4. Must NOT modify `lib/statusView.ts` in any way.
5. Must NOT break any existing tests — `npm test` passes before and after.
6. Must use `import figlet from 'figlet'` (default import only — figlet is CJS).

---

## Implementation

### Step 1 — Add dependencies

**File:** `package.json`

Add to `"dependencies"`:
```json
"boxen": "8.0.1",
"chalk": "5.4.1",
"figlet": "1.8.0"
```

Add to `"devDependencies"`:
```json
"@types/figlet": "1.7.0"
```

Run `npm install` to update `package-lock.json`.

### Step 2 — Create `lib/banner.ts`

```typescript
import figlet from 'figlet';
import chalk from 'chalk';

export function renderBanner(): string {
  const art = figlet.textSync('ORC-STATE', { font: 'Doom' });
  return chalk.green(chalk.bold(art));
}
```

### Step 3 — Create `lib/colorStatus.ts`

Post-process the plain-text output from `formatStatus` / `formatAgentStatus` with regex-based chalk coloring. Do not reconstruct the string from scratch — wrap the existing output.

```typescript
import chalk from 'chalk';
import { formatStatus, formatAgentStatus, buildStatus, buildAgentStatus } from './statusView.js';

// Re-export types for convenience
export type { };

function applyColors(text: string): string {
  return text
    // Section headers (lines that appear at the start of a line, followed by nothing or a colon)
    .replace(/^(Orchestrator Status|Master:|Worker Capacity:|Active Runs[^:]*:|Finalization[^:]*:|Recent Failures[^:]*:|Tasks:|Recent Events:)$/gm,
      s => chalk.bold.cyan(s))
    // Positive states
    .replace(/\b(running|in_progress|attached|available)\b/g, s => chalk.green(s))
    // Warning states
    .replace(/\b(claimed|warming)\b/g, s => chalk.yellow(s))
    // Negative states
    .replace(/\b(blocked|failed|unavailable|session_start_failed|run_failed)\b/g, s => chalk.red(s))
    // Completed states
    .replace(/\b(done|released|offline)\b/g, s => chalk.gray(s));
}

export function colorFormatStatus(status: ReturnType<typeof buildStatus>): string {
  return applyColors(formatStatus(status));
}

export function colorFormatAgentStatus(status: ReturnType<typeof buildAgentStatus>, agentId: string): string {
  return applyColors(formatAgentStatus(status, agentId));
}
```

---

## Acceptance criteria

- [ ] `npm install` succeeds with the four new packages at exact versions.
- [ ] `renderBanner()` returns a non-empty string containing multi-line figlet art.
- [ ] `colorFormatStatus(buildStatus(dir))` returns a string containing ANSI escape codes when stdout is a TTY (chalk level > 0).
- [ ] `colorFormatStatus(buildStatus(dir))` returns plain text identical to `formatStatus(buildStatus(dir))` (modulo ANSI wrappers on matched tokens) — no content is lost.
- [ ] `npm test` passes with zero failures — `lib/statusView.test.ts` assertions unchanged.
- [ ] No changes to any file outside the stated scope.

---

## Tests

Add to `lib/colorStatus.test.ts` (new file):

```typescript
import { describe, it, expect } from 'vitest';
import { colorFormatStatus } from './colorStatus.js';
import { buildStatus } from './statusView.js';

describe('colorFormatStatus', () => {
  it('returns a string', () => {
    // Use a temp dir with no state files — buildStatus handles missing files gracefully
    const result = colorFormatStatus(buildStatus('/tmp/nonexistent-orc-test'));
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('preserves plain-text content (ANSI stripped)', () => {
    const status = buildStatus('/tmp/nonexistent-orc-test');
    const plain = formatStatus(status);
    // Strip ANSI from colored output and compare key phrases
    const stripped = colorFormatStatus(status).replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripped).toContain('Orchestrator Status');
  });
});
```

---

## Verification

```bash
npx vitest run lib/colorStatus.test.ts
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** figlet CJS interop — if default import fails at runtime, banner renders nothing.
**Rollback:** revert `package.json` and delete `lib/banner.ts` + `lib/colorStatus.ts`. No state files touched.
