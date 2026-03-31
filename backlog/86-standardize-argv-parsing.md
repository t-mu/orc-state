---
ref: craftsmanship-structure/86-standardize-argv-parsing
feature: craftsmanship-structure
priority: normal
status: todo
depends_on:
  - craftsmanship-foundations/70-extract-cli-shared-utils
---

# Task 86 — Standardize CLI Argv Parsing with boolFlag()

Depends on Task 70.

## Scope

**In scope:**
- Add `boolFlag(name)` to `lib/args.ts` for boolean flag parsing
- Migrate CLI files using `process.argv.includes('--flag')` to use `boolFlag()`

**Out of scope:**
- Rewriting the entire argument parsing system
- Adding a CLI framework dependency

---

## Context

### Current state

CLI files use 4 different patterns for argument parsing: `process.argv.includes()`, `.slice(2).find()`, `flag()` helper, and direct indexing. Boolean flags are the most common inconsistency.

### Desired state

All boolean flags use `boolFlag(name)` from `lib/args.ts`, consistent with existing `flag()` and `intFlag()`.

### Start here

- `lib/args.ts` — existing `flag()` and `intFlag()` helpers
- `cli/doctor.ts`, `cli/init.ts`, `cli/kill-all.ts` — files using `process.argv.includes`

**Affected files:**
- `lib/args.ts` — add `boolFlag()` export
- CLI files using `process.argv.includes('--X')` — migrate to `boolFlag('X')`

---

## Goals

1. Must add `boolFlag(name, argv?)` to `lib/args.ts`
2. Must migrate all `process.argv.includes('--X')` patterns to `boolFlag('X')`
3. Must not change any CLI behavior

---

## Acceptance criteria

- [ ] `boolFlag` exported from `lib/args.ts`
- [ ] No `process.argv.includes('--` patterns remain in CLI files
- [ ] `npm test` passes

---

## Verification

```bash
npm test
```
