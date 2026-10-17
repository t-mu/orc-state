---
ref: vnext-control-plane/196-pin-markdown-task-revisions
feature: vnext-control-plane
review_level: full
priority: high
status: done
---

# Task 196 — Pin Markdown task revisions at dispatch

Independent of Task 194.

## Scope

**In scope:** Rebuildable Markdown index with hash/validation and immutable run snapshot at claim/dispatch.

**Out of scope:** Changing task file syntax, automatic redispatch, or replacing dependency routing.

---

## Context

### Current state

`lib/backlogSync.ts` indexes selected frontmatter into JSON; the worker later reads the live spec. An edit during execution can change instructions without a new run.

### Desired state

The run identifies the exact Markdown revision it received and reports when the source file has moved on.

### Start here

- `lib/backlogSync.ts` — spec discovery.
- `lib/claimManager.ts` — run creation.

**Affected files:** document index, claim/dispatch code, snapshot tests.

---

## Goals

1. Must keep Markdown canonical and index rebuildable from `backlog/` and `plans/`.
2. Must capture content hash and Markdown snapshot with a run before worker instruction delivery.
3. Must mark stale revision without silently replacing an active run's instructions.

## Implementation

1. Extract reusable document discovery/hash validation around existing parsers.
2. At claim, persist a run-scoped snapshot and expose it to task-envelope construction.
3. Add tests for edits after claim, invalid spec, restart/reindex, and sibling layout.

## Acceptance criteria

- [ ] Worker receives the pinned revision after the original file changes.
- [ ] Index rebuild preserves run snapshots and reports stale status.
- [ ] Existing Markdown format and dispatch eligibility remain unchanged.

## Tests

Add focused index and dispatch integration tests with an edited source spec.

## Verification

`npm test`; `orc doctor` against migrated test state.

## Risk / Rollback

**Risk:** A snapshot and claim could diverge across files. **Rollback:** Retain the old spec read path until the transactional run store lands; reconcile orphan snapshots by run ID.
