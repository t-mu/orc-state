---
ref: craftsmanship-foundations/68-consolidate-constants-enums
feature: craftsmanship-foundations
priority: normal
status: todo
---

# Task 68 — Consolidate Constants and Enums into Single Source of Truth

Independent.

## Scope

**In scope:**
- Make `lib/constants.ts` the single source of truth for all validation enums and regex patterns
- Remove duplicate definitions from `mcp/handlers.ts` and `lib/agentRegistry.ts`

**Out of scope:**
- JSON schema files (`schemas/*.json`) — these are declarative and may legitimately duplicate values
- TypeScript type unions in `types/*.ts` — these serve a different purpose (compile-time vs runtime)

---

## Context

### Current state

Validation sets (`TASK_STATUSES`, `AGENT_ROLES`, `TASK_TYPES`, `TASK_PRIORITIES`) are defined as arrays in `lib/constants.ts`, then redefined as `new Set(...)` locally in `mcp/handlers.ts` (lines 23-26). The `AGENT_ID_RE` regex is in `lib/constants.ts`, but an identical `ACTOR_ID_RE` is defined locally in `mcp/handlers.ts` (line 27), and the same pattern appears inline in `lib/agentRegistry.ts`.

### Desired state

All runtime validation constants and regex patterns are imported from `lib/constants.ts`. No local redefinitions.

### Start here

- `lib/constants.ts` — existing constant definitions
- `mcp/handlers.ts` — lines 23-27, local redefinitions to remove
- `lib/agentRegistry.ts` — inline regex to replace with import

**Affected files:**
- `lib/constants.ts` — add any missing exports
- `mcp/handlers.ts` — replace local constants with imports
- `lib/agentRegistry.ts` — replace inline regex with import

---

## Goals

1. Must have all validation enum arrays and regex patterns exported from `lib/constants.ts`
2. Must remove local `TASK_STATUSES`, `AGENT_ROLES`, `ACTOR_ID_RE` definitions from `mcp/handlers.ts`
3. Must remove inline `AGENT_ID_RE` pattern from `lib/agentRegistry.ts`
4. Must not change any runtime behavior

---

## Acceptance criteria

- [ ] `lib/constants.ts` exports `TASK_STATUSES`, `TASK_TYPES`, `TASK_PRIORITIES`, `AGENT_ROLES`, `AGENT_ID_RE`, `TASK_REF_RE`
- [ ] `mcp/handlers.ts` imports these from `lib/constants.ts` instead of defining locally
- [ ] `lib/agentRegistry.ts` imports `AGENT_ID_RE` instead of defining inline
- [ ] `npm test` passes
- [ ] No changes to files outside the stated scope

---

## Verification

```bash
npx vitest run mcp/handlers.test.ts lib/agentRegistry.test.ts
```

```bash
npm test
```
