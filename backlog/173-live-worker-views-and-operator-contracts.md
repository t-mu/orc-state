---
ref: dynamic-workers/173-live-worker-views-and-operator-contracts
feature: dynamic-workers
review_level: full
priority: normal
status: todo
depends_on:
  - dynamic-workers/172-dynamic-worker-spawn-and-provider-routing
---

# Task 173 — Update Live Worker Views and Operator Surfaces

Depends on Task 172.

## Scope

**In scope:**
- Update TUI and status surfaces to show configured capacity, active live workers, and available capacity without assuming persistent idle worker slots.
- Update operator-facing CLI/help text and runtime views that currently imply stable `orc-N` worker identities.
- Add regression coverage for live-worker presentation and ephemeral-worker operator flows.

**Out of scope:**
- Core dispatch implementation, provider routing, or runtime cleanup logic beyond what is necessary to consume the new model.
- Changing scout UX or unrelated notification design.
- Additional provider features beyond per-task dynamic worker selection.
- Architecture, contracts, recovery docs, testing docs, and AGENTS updates, which are handled in Task 174.

---

## Context

Once the runtime stops maintaining persistent worker slots, the operator surfaces need to change with it. `orc watch` and status views can no longer present workers as permanent idle lanes. They need to show actual live sessions plus a computed capacity summary.

This is not just cosmetic. The old presentation model teaches the wrong mental model and makes debugging harder because it suggests worker identities are durable when they are now task-scoped. Operator commands such as attach/control also need to remain usable even though worker IDs disappear when work completes.

This task finishes the operator-surface side of the architecture shift by aligning the TUI and CLI text with the new runtime behavior. The broader documentation pass is split into Task 174 so this implementation unit stays focused on executable surfaces and their tests.

**Start here:**
- `lib/statusView.ts` and TUI components under `lib/tui/` — current worker display assumptions
- `cli/*.ts` that mention `orc-1`-style workers or persistent worker lists
- `lib/workerCapacity.ts` or the shared capacity helper introduced in Task 171 — capacity source of truth for views

**Affected files:**
- `lib/statusView.ts` — render capacity summary plus live workers only
- `lib/tui/*` — remove assumptions about persistent idle worker lanes
- `cli/status.ts`, `cli/watch.ts`, `cli/attach.ts`, `cli/control-worker.ts` — operator-facing messaging for ephemeral workers
- `*.test.ts` covering status/TUI/CLI surfaces — regression coverage for live-worker presentation

---

## Goals

1. Must present worker capacity separately from the live worker list.
2. Must show only currently live worker sessions in watch/status views.
3. Must keep attach/control flows usable with ephemeral worker IDs.
4. Must remove user-facing text that implies stable `orc-N` worker slots.
5. Must keep operator-facing views and messages consistent with the shared live-worker capacity model from Task 171.

---

## Implementation

### Step 1 — Update status and TUI rendering

**Files:** `lib/statusView.ts`, `lib/tui/*`

Replace slot-oriented rendering with explicit capacity summary fields:

```ts
const summary = getWorkerCapacitySummary(...);
```

Render only live workers in lists/cards/panels. Use the shared capacity helper from Task 171 instead of deriving availability from the rendered live list length. When a task finishes, its worker should disappear from the live list rather than becoming an idle placeholder row.

### Step 2 — Update operator-facing CLI assumptions

**Files:** `cli/status.ts`, `cli/watch.ts`, `cli/attach.ts`, `cli/control-worker.ts`

Remove stale text that implies stable slot workers. Ensure help and error messages reflect:
- worker IDs are human-readable two-word live-session names
- workers disappear after task completion
- capacity remains visible separately from the worker list

### Step 3 — Add view and operator regression tests

**Files:** `lib/statusView.test.ts`, relevant TUI tests, CLI tests

Add tests that assert:
- no idle placeholder workers are rendered
- capacity summary is correct while workers are active and after cleanup
- attach/control/status output handles ephemeral worker names and disappearance cleanly

---

## Acceptance criteria

- [ ] Status and TUI surfaces show configured capacity, active live workers, and available capacity separately.
- [ ] No watch/status surface renders persistent idle worker slot placeholders.
- [ ] Operator-facing CLI text no longer implies stable `orc-N` worker identities.
- [ ] Attach/control flows remain usable for currently live ephemeral workers.
- [ ] Tests cover live-worker rendering and operator-facing ephemeral-worker behavior.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update tests in `lib/statusView.test.ts` and TUI test files:

```ts
it('renders only live workers and a separate capacity summary', () => { ... });
it('removes a worker from the view when its task-scoped session ends', () => { ... });
```

Add or update CLI tests:

```ts
it('reports live two-word worker ids without implying persistent slots', () => { ... });
it('shows capacity separately from the live worker list', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/statusView.test.ts
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Operator surfaces can drift from runtime reality and confuse debugging if any view still mixes computed capacity with live-worker state.
**Rollback:** `git restore lib/statusView.ts lib/tui cli/status.ts cli/watch.ts cli/attach.ts cli/control-worker.ts && npm test`
