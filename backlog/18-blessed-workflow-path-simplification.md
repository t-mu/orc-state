---
ref: general/18-blessed-workflow-path-simplification
feature: general
priority: normal
status: done
---

# Task 18 — Simplify the Orchestrator Around Blessed Workflow Paths

Depends on Task 17.

## Scope

**In scope:**
- Inventory overlapping workflow paths for task authoring, task sync, worker lifecycle reporting, and recovery/finalization
- Choose one blessed operator/agent path per concern
- Deprecate, downgrade, or relabel secondary paths where they create confusion without enough value
- Update docs and shipped guidance to reflect the blessed paths

**Out of scope:**
- Large behavioral refactors to the underlying lifecycle model
- Failure-injection test expansion except where needed to protect the chosen path
- Event reducer extraction

---

## Context

Even with better invariants, the repository still supports multiple overlapping ways to perform the same orchestration steps. That makes the system harder to document, harder for agents to use consistently, and harder for operators to debug.

### Current state

There are several workflow surfaces where primary and secondary paths coexist without a clear product-level recommendation. Some of those variants exist for historical or debugging reasons, but they still appear like first-class options in docs and guidance.

### Desired state

Each major orchestration concern should have one documented, blessed path. Secondary or debug-only paths should be clearly marked, downgraded, or removed where practical so both humans and agents converge on the same workflow.

### Start here

- `README.md` — current documented operator flows
- `AGENTS.md` — current task-execution instructions for coding agents
- `cli/orc.ts` — current command surface and aliases

**Affected files:**
- `README.md` — operator-facing blessed workflow docs
- `AGENTS.md` — agent-facing blessed workflow docs
- `cli/orc.ts` and individual CLI entrypoints — deprecation labels or command-surface cleanup
- `skills/` and `templates/` — shipped guidance that needs to match the chosen paths

---

## Goals

1. Must identify and document one blessed path for each major workflow concern in scope.
2. Must reduce ambiguity in docs, skills, and templates about which path agents and operators should follow.
3. Must preserve necessary debug or recovery paths only when they add clear value.
4. Must avoid silently breaking existing workflows without a documented replacement.
5. Must keep the scope on workflow convergence, not deep runtime redesign.

---

## Implementation

### Step 1 — Inventory overlapping paths

**File:** `README.md`

Identify where docs and command surfaces currently present multiple competing flows.

### Step 2 — Choose and encode the blessed path

**File:** `AGENTS.md`

Update the agent and operator guidance so each concern has one primary recommended path.

### Step 3 — Downgrade secondary paths

**File:** `cli/orc.ts`

Mark secondary/debug flows clearly or remove thin aliases that add confusion without enough value. Keep compatibility where necessary, but stop presenting secondary paths as equivalent defaults.

---

## Acceptance criteria

- [ ] The repo documents one blessed path for each workflow concern in scope.
- [ ] Debug-only or secondary paths are clearly labeled or downgraded.
- [ ] Shipped skills/templates match the blessed workflow descriptions.
- [ ] Existing supported workflows are not removed without an explicit documented replacement.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update tests around command help/output where behavior changes, for example in `cli/*.test.ts`:

```ts
it('documents the blessed workflow path in command help or docs-linked output', () => { ... });
it('marks secondary paths as deprecated or debug-only where applicable', () => { ... });
```

---

## Verification

```bash
# Targeted verification for this task only
npx vitest run cli/*.test.ts
```

```bash
# Final required repo-wide checks before marking the task done
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Simplifying the visible workflow too aggressively can remove useful escape hatches or create undocumented regressions for operators.
**Rollback:** Revert the doc and command-surface simplification together and restore the previous guidance while keeping the invariant checks from Task 17 intact.
