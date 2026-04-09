---
ref: general/154-docs-architecture
feature: general
priority: high
status: todo
depends_on:
  - general/153-docs-concepts
---

# Task 154 — Create docs/architecture.md System Overview

Depends on Task 153 (references terms defined in concepts.md).

## Scope

**In scope:**
- Create `docs/architecture.md` with high-level system overview for human readers
- ASCII diagram showing the runtime flow
- Component roles, data flow, state directory layout, worktree isolation

**Out of scope:**
- Schema definitions or state machine invariants (link to contracts.md)
- CLI command details (link to cli.md)
- Configuration options (link to configuration.md)
- Agent-facing workflow instructions (AGENTS.md covers those)

---

## Context

A new consumer has no "how it works" overview. The getting-started guide walks
through usage, but doesn't explain the system architecture. contracts.md covers
invariants at depth but isn't a beginner-friendly overview. This doc fills the
gap: the 30-second "how does this system work?" answer.

**Affected files:**
- `docs/architecture.md` — new file

---

## Goals

1. Must explain the system in under 200 lines.
2. Must include an ASCII diagram of the runtime flow.
3. Must explain what each component does (coordinator, master, worker).
4. Must explain the data flow from task spec to merged code.
5. Must explain worktree isolation and why it matters.
6. Must link to concepts.md for terminology, contracts.md for invariants, configuration.md for settings.
7. Must be written for human developers, not LLM agents.

---

## Implementation

### Step 1 — Create docs/architecture.md

**File:** `docs/architecture.md`

Sections:

1. **Overview** — one paragraph: "orc-state is a local orchestration runtime that dispatches coding tasks to autonomous AI agents."

2. **Runtime diagram** (ASCII):
```
orc start-session
    |
    +---> Coordinator (background)     Master (foreground)
              |                             |
              | ticks every ~30s            | user interaction
              |                             | task creation
              v                             | monitoring
         Pick eligible task
              |
              v
         Spawn worker in .worktrees/<run-id>/
              |
              v
         Worker: explore -> implement -> review -> complete
              |
              v
         Coordinator merges to main, cleans up worktree
```

3. **Components** — one paragraph each for coordinator, master, worker, with what they own and don't own.

4. **Data flow** — markdown spec in `backlog/` → coordinator syncs to `backlog.json` → task becomes eligible → claim created → worker spawned → events emitted to `events.db` → work complete → merge → task released.

5. **State directory** — what's in `.orc-state/`: backlog.json, agents.json, claims.json, events.db, memory.db. One sentence each. Link to contracts.md for schemas.

6. **Worktree isolation** — why each task gets its own git worktree, how parallel work avoids conflicts, how merge-back works.

---

## Acceptance criteria

- [ ] `docs/architecture.md` exists.
- [ ] Contains an ASCII runtime flow diagram.
- [ ] Explains coordinator, master, and worker roles.
- [ ] Explains the data flow from task spec to merged code.
- [ ] Explains state directory contents.
- [ ] Explains worktree isolation.
- [ ] Links to concepts.md, contracts.md, and configuration.md.
- [ ] Under 200 lines.
- [ ] Written for human developers.
- [ ] No changes to files outside the stated scope.

---

## Tests

No code tests — documentation only.

---

## Verification

```bash
test -s docs/architecture.md && echo "OK"
wc -l docs/architecture.md  # should be under 200
```
