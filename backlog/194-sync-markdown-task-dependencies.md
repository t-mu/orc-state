---
ref: vnext-control-plane/194-sync-markdown-task-dependencies
feature: vnext-control-plane
review_level: light
priority: high
status: todo
---

# Task 194 — Sync Markdown task dependencies into runtime state

Independent. This is the first safe implementation slice.

## Scope

**In scope:** Parse `depends_on` lists from task Markdown frontmatter and update the runtime backlog during spec sync.

**Out of scope:** Changing task file format, scheduler logic, or other task metadata.

---

## Context

### Current state

`lib/planSpecTask.ts` writes `depends_on` frontmatter, but `lib/backlogSync.ts` only reads ref, feature, status, review level and merge strategy. Newly published dependent tasks can therefore appear independent in `backlog.json`.

### Desired state

Markdown dependencies are the source of truth at sync and dispatch, including for newly created tasks. Active tasks must not silently change their pinned dependency set.

### Start here

- `lib/backlogSync.ts` — spec discovery and runtime sync.
- `lib/planSpecTask.ts` — emitted frontmatter format.

**Affected files:** `lib/backlogSync.ts`, `lib/backlogSync.test.ts`.

---

## Goals

1. Must read the existing YAML-style `depends_on` list emitted by spec generation.
2. Must propagate dependencies for new and safely updateable tasks while preserving active run state.
3. Must reject malformed or self-referential dependencies with a clear validation result instead of dispatching them as independent.

## Implementation

1. Extend frontmatter parsing in `lib/backlogSync.ts` with a narrow, tested dependency-list reader.
2. Include the parsed list in new task records and controlled updates; prevent active task mutation.
3. Add cases for absent, valid, malformed, duplicate and self dependency lists.

## Acceptance criteria

- [ ] A spec with `depends_on` creates a runtime task with the same refs.
- [ ] Missing or malformed dependency data cannot silently create an eligible independent task.
- [ ] Active claims keep their existing dependency set; existing sync/status tests pass.

## Tests

Add parser and sync integration cases in `lib/backlogSync.test.ts`.

## Verification

`npx vitest run lib/backlogSync.test.ts`; `npm test`; `orc doctor` against a temporary synced backlog.

## Risk / Rollback

**Risk:** Bad frontmatter could block task sync. **Rollback:** Restore previous binary and correct malformed specs before retry; do not silently ignore dependency errors.
