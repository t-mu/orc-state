---
ref: general/152-lib-logger-abstraction
feature: general
priority: normal
status: todo
---

# Task 152 — Replace console.* with Zero-Dep Logger in lib Modules

Independent.

## Scope

**In scope:**
- Create `lib/logger.ts` — thin zero-dependency wrapper over `console` with level gating
- Create `lib/logger.test.ts` with level gating tests
- Replace `console.*` calls in ~15 `lib/` files (~60 occurrences)
- Preserve user-facing config validation warnings in `lib/providers.ts`

**Out of scope:**
- Modifying `cli/` files (console output is appropriate for CLI commands)
- Modifying `coordinator.ts` (root-level, too large — follow-up task)
- Adding npm dependencies (zero-dep logger only)
- Structured logging, log rotation, or file-based logging
- Changing log output format (keep plain text)

---

## Context

~15 `lib/` files use raw `console.log/warn/error` (~60 occurrences). When
the framework is used as a CLI tool, this output mixes with the user's own
output. A thin logger with level gating lets consumers control verbosity via
`ORC_LOG_LEVEL` without silencing important warnings.

Key constraint: `lib/providers.ts` uses `console.warn` for user-facing config
validation (e.g., "unknown provider", "invalid max_workers"). These warnings
must remain visible at the default log level.

`AGENTS.md` prohibits adding npm dependencies without asking. The logger must
use only Node.js builtins.

`coordinator.ts` has the most `console` calls but is root-level (not `lib/`),
very large, and higher risk. It is explicitly excluded and left for a follow-up.

**Affected files:**
- `lib/logger.ts` — new file
- `lib/logger.test.ts` — new file
- ~15 `lib/*.ts` files — replace `console.*` with logger calls

---

## Goals

1. Must provide level-gated logging (debug, info, warn, error).
2. Must default to showing `warn` and above.
3. Must be configurable via `ORC_LOG_LEVEL` environment variable.
4. Must not introduce any npm dependencies.
5. Must preserve config validation warnings in `lib/providers.ts` at default level.
6. Must not touch `cli/` files or `coordinator.ts`.

---

## Implementation

### Step 1 — Create lib/logger.ts

**File:** `lib/logger.ts`

```typescript
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 } as const;
type LogLevel = keyof typeof LEVELS;

const threshold: number = LEVELS[
  (process.env.ORC_LOG_LEVEL?.toLowerCase() as LogLevel) ?? 'warn'
] ?? LEVELS.warn;

export const logger = {
  debug: (...args: unknown[]) => { if (threshold <= LEVELS.debug) console.debug(...args); },
  info:  (...args: unknown[]) => { if (threshold <= LEVELS.info)  console.log(...args); },
  warn:  (...args: unknown[]) => { if (threshold <= LEVELS.warn)  console.warn(...args); },
  error: (...args: unknown[]) => { if (threshold <= LEVELS.error) console.error(...args); },
};
```

### Step 2 — Create lib/logger.test.ts

**File:** `lib/logger.test.ts`

```typescript
describe('logger', () => {
  it('suppresses debug at default warn level', () => { ... });
  it('shows warn at default level', () => { ... });
  it('shows error at default level', () => { ... });
  it('respects ORC_LOG_LEVEL=debug', () => { ... });
  it('respects ORC_LOG_LEVEL=silent', () => { ... });
  it('falls back to warn for invalid ORC_LOG_LEVEL', () => { ... });
});
```

### Step 3 — Migrate lib/ files

For each of the ~15 `lib/*.ts` files with `console.*` calls:

1. Add `import { logger } from './logger.ts';`
2. Replace `console.log(...)` → `logger.info(...)`
3. Replace `console.warn(...)` → `logger.warn(...)`
4. Replace `console.error(...)` → `logger.error(...)`

**Exception for `lib/providers.ts`:** Config validation warnings use
`console.warn` for user-facing messages. Replace with `logger.warn` — these
remain visible at the default `warn` threshold.

Invariant: do not modify files in `cli/` or `coordinator.ts`.

---

## Acceptance criteria

- [ ] `lib/logger.ts` exists with `debug`, `info`, `warn`, `error` methods.
- [ ] Default level is `warn` (debug and info suppressed).
- [ ] `ORC_LOG_LEVEL` env var controls the threshold.
- [ ] Invalid `ORC_LOG_LEVEL` values fall back to `warn`.
- [ ] ~15 `lib/` files migrated from `console.*` to `logger.*`.
- [ ] Config validation warnings in `lib/providers.ts` remain visible at default level.
- [ ] No `cli/` files or `coordinator.ts` modified.
- [ ] No npm dependencies added.
- [ ] `lib/logger.test.ts` exists with level gating tests.
- [ ] `npm test` passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add `lib/logger.test.ts`:

```typescript
it('suppresses debug at default warn level', () => { ... });
it('shows warn at default level', () => { ... });
it('shows error at default level', () => { ... });
it('respects ORC_LOG_LEVEL=debug to show all levels', () => { ... });
it('respects ORC_LOG_LEVEL=silent to suppress all output', () => { ... });
it('falls back to warn for invalid ORC_LOG_LEVEL value', () => { ... });
```

---

## Verification

```bash
nvm use 24 && npm test
```
