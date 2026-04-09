---
ref: general/153-docs-concepts
feature: general
priority: high
status: todo
---

# Task 153 — Create docs/concepts.md Terminology Reference

Independent.

## Scope

**In scope:**
- Create `docs/concepts.md` defining 11 core terms for human readers
- Audit `docs/getting-started.md` for inline definitions that should link to concepts.md instead
- Audit `docs/contracts.md` for overlapping terminology sections

**Out of scope:**
- Rewriting getting-started.md or contracts.md (Task 157 handles cross-linking)
- Implementation details or state machine rules (link to contracts.md for those)
- Agent-facing instructions (AGENTS.md is the agent reference)

---

## Context

Every human-facing doc uses terms like "coordinator", "master", "worker", "claim",
and "run" without defining them. A new consumer reading the docs must piece together
definitions from scattered references across multiple files. This creates a single
canonical glossary that other docs can link to.

`docs/getting-started.md` lines 150-158 inline-defines some concepts (coordinator
claims task, worker starts, sub-agent reviewers). `docs/contracts.md` defines terms
in a system-contract context (lines 220+). Neither is a clean human-friendly glossary.

**Affected files:**
- `docs/concepts.md` — new file

---

## Goals

1. Must define all 11 terms: coordinator, master, worker, scout, task, run, claim, feature, worktree, provider, adapter.
2. Must be written for human developers, not LLM agents.
3. Must include a one-sentence "when you'll encounter this" for each term.
4. Must not duplicate implementation details from contracts.md — link to it instead.
5. Must be usable as a link target from other docs.

---

## Implementation

### Step 1 — Create docs/concepts.md

**File:** `docs/concepts.md`

Structure for each term:
```markdown
### Coordinator
The background Node.js process that manages the task lifecycle. It ticks
periodically, dispatches eligible tasks to workers, monitors worker health,
and merges completed work back to main.

_You'll encounter this when running `orc start-session` — it starts the
coordinator automatically._
```

Terms to define:
1. **Coordinator** — background dispatch/lifecycle process
2. **Master** — foreground agent session (the user's conversation)
3. **Worker** — headless agent spawned per-task in an isolated worktree
4. **Scout** — ephemeral read-only investigation agent
5. **Task** — unit of work defined by a markdown spec in backlog/
6. **Run** — one execution attempt of a task (task can have multiple runs)
7. **Claim** — binding between a run, task, and worker
8. **Feature** — grouping of related tasks in the backlog
9. **Worktree** — isolated git checkout per worker, prevents conflicts
10. **Provider** — AI backend (Claude, Codex, Gemini)
11. **Adapter** — interface between coordinator and provider CLI (link to adapters.md)

Add a header note: "For system invariants and state machine rules, see [Contracts & invariants](./contracts.md)."

### Step 2 — Identify getting-started.md inline definitions

Read `docs/getting-started.md` and note lines that define terms inline (e.g., lines 150-158). These will be refactored to link to concepts.md in Task 157.

Document findings in a code comment or note at the bottom of concepts.md for Task 157's reference.

---

## Acceptance criteria

- [ ] `docs/concepts.md` exists with all 11 terms defined.
- [ ] Each term has a short definition and "when you'll encounter this" note.
- [ ] Written for human developers (no agent jargon like "emit", "spawn sub-agents").
- [ ] Links to `contracts.md` for deeper system rules.
- [ ] Links to `adapters.md` from the adapter term.
- [ ] No implementation details (code paths, function names, state file internals).
- [ ] No changes to files outside the stated scope.

---

## Tests

No code tests — documentation only.

---

## Verification

```bash
# Verify file exists and is non-empty
test -s docs/concepts.md && echo "OK"
```
