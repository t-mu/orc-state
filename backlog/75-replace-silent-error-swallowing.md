---
ref: craftsmanship-foundations/75-replace-silent-error-swallowing
feature: craftsmanship-foundations
priority: normal
status: todo
---

# Task 75 — Replace Silent catch {} Blocks with Structured Error Logging

Independent.

## Scope

**In scope:**
- Add error discrimination to silent `catch {}` blocks in lib/ files
- Log unexpected errors while keeping intentional silent catches (file-not-found) documented

**Out of scope:**
- Adding a logging framework
- Changing error recovery behavior

---

## Context

### Current state

Multiple `catch {}` blocks in `lib/stateReader.ts`, `lib/agentRegistry.ts`, `lib/paths.ts`, and `lib/eventLog.ts` silently swallow all errors, including unexpected ones like permission errors or JSON corruption.

### Desired state

Each catch block either: (a) checks for expected error codes (e.g., `ENOENT`) and only silences those, logging unexpected errors to stderr, or (b) has a comment explaining why silent swallowing is intentional.

### Start here

- `lib/stateReader.ts` — lines 26-28, 32-36
- `lib/agentRegistry.ts` — line 15
- `lib/paths.ts` — lines 45-63

**Affected files:**
- `lib/stateReader.ts` — add error discrimination
- `lib/agentRegistry.ts` — add error discrimination
- `lib/paths.ts` — add comments or discrimination
- `lib/eventLog.ts` — add error discrimination to migration catch

---

## Goals

1. Must add `ENOENT` discrimination to file-read catch blocks
2. Must log unexpected errors to stderr with module context
3. Must keep intentional silent catches documented with comments
4. Must not change return values or error recovery behavior

---

## Acceptance criteria

- [ ] No bare `catch {}` blocks remain in the affected files
- [ ] Expected file-not-found errors remain silent
- [ ] Unexpected errors produce a stderr warning
- [ ] `npm test` passes
- [ ] No changes to files outside the stated scope

---

## Verification

```bash
npx vitest run lib/stateReader.test.ts lib/agentRegistry.test.ts
```

```bash
npm test
```

---

## Tests

Pure refactoring — no new tests. Existing tests must continue to pass.
