---
ref: general/157-docs-fix-existing
feature: general
priority: normal
status: done
depends_on:
  - general/153-docs-concepts
  - general/154-docs-architecture
  - general/155-docs-cli-complete
  - general/156-docs-recovery-expand
---

# Task 157 — Fix Issues in Existing Human Documentation

Depends on Tasks 153, 154, 155, 156 (needs new docs and corrected cli.md to exist for linking).

## Scope

**In scope:**
- `README.md` — add missing doc links
- `docs/getting-started.md` — fix factual heartbeat error, link to concepts.md
- `docs/configuration.md` — add model name note, explain default asymmetry
- `docs/contracts.md` — fix heartbeat section (lines 274-295) to match AGENTS.md
- `docs/memory.md` — clarify CLI/MCP parity
- `docs/adapters.md` — link to architecture.md
- All human docs — add "See also" footer with cross-links

**Out of scope:**
- `docs/concepts.md` and `docs/architecture.md` (created by Tasks 153-154)
- AGENTS.md or any agent-facing documentation
- Code changes

---

## Context

The documentation audit found several issues in existing human-facing docs:

1. **README.md** (line 27-33) links to 6 docs but `memory.md`, `testing.md`,
   and `recovery.md` are not discoverable from the index. New `concepts.md`
   and `architecture.md` also need links.

2. **getting-started.md** line 158 states "Workers heartbeat every 4.5 minutes"
   which contradicts AGENTS.md. Liveness is determined by the coordinator
   probing the worker's PTY PID. Heartbeat is a protocol signal, not a timer.

3. **contracts.md** lines 274-295 prescribe a background heartbeat loop at
   4.5-min intervals with "Workers MUST keep the lease alive." Line 319
   shows "orc run-heartbeat (repeating, extends lease)" in the lifecycle
   diagram. Line 382 references "background heartbeat loop during the wait."
   All three contradict AGENTS.md which says liveness is PID-based and
   heartbeat is a protocol signal at key lifecycle points.

4. **configuration.md** hardcodes model names that will go stale. The
   master-defaults-to-claude / worker-defaults-to-codex asymmetry is
   unexplained.

5. **memory.md** documents CLI and MCP tools in separate sections without
   noting they are equivalent interfaces to the same system.

6. No doc links to any other doc via "See also" footers.

**Start here:** `README.md` (primary entry point for consumers)

**Affected files:**
- `README.md` — add doc links
- `docs/getting-started.md` — fix line 158, add concept links
- `docs/contracts.md` — rewrite heartbeat section (lines 274-295, 319, 382)
- `docs/configuration.md` — add notes
- `docs/memory.md` — add parity note
- `docs/adapters.md` — add architecture link

---

## Goals

1. Must add all missing doc links to README.md.
2. Must fix the factual heartbeat error in getting-started.md line 158.
3. Must rewrite contracts.md heartbeat section (lines 274-295) to match AGENTS.md.
4. Must add model-name caveat and default-asymmetry explanation to configuration.md.
5. Must add CLI/MCP parity note to memory.md.
6. Must add "See also" footer to all human-facing docs.

---

## Implementation

### Step 1 — Fix README.md doc links

**File:** `README.md`

Replace lines 27-33 with expanded list:

```markdown
## Documentation

- [Concepts & terminology](./docs/concepts.md)
- [Architecture overview](./docs/architecture.md)
- [Getting started](./docs/getting-started.md)
- [Configuration](./docs/configuration.md)
- [CLI reference](./docs/cli.md)
- [Memory system](./docs/memory.md)
- [Writing custom adapters](./docs/adapters.md)
- [Testing](./docs/testing.md)
- [Contracts & invariants](./docs/contracts.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Recovery guide](./docs/recovery.md)
```

### Step 2 — Fix getting-started.md heartbeat error

**File:** `docs/getting-started.md`

Replace line 158:
```
Workers heartbeat every 4.5 minutes. If a worker goes silent, the coordinator expires the claim and requeues the task.
```
with:
```
The coordinator monitors worker health by probing the worker process. If a worker dies, the coordinator expires the claim and requeues the task.
```

Also replace inline concept definitions (lines 150-158) with links to concepts.md where appropriate.

### Step 3 — Rewrite contracts.md heartbeat section

**File:** `docs/contracts.md`

Replace lines 274-295 (the "Heartbeat contract" section) with content aligned
to AGENTS.md:

```markdown
### Heartbeat contract

Liveness is determined by the coordinator: on each tick it probes the worker's
PTY PID via `process.kill(pid, 0)`. If the PID is dead, the coordinator clears
the agent session, expires the claim, and requeues the task.

Workers emit `orc run-heartbeat` as a **protocol signal** at key lifecycle
points, not as a periodic timer:

- Before spawning sub-agent reviewers
- Before `git rebase main`
- Before `orc run-work-complete`

The heartbeat updates `last_heartbeat_at` on the claim, providing an
additional observability signal, but is not the primary liveness mechanism.
```

Remove the background loop code example and "Workers MUST keep the lease alive" phrasing.

Also fix:
- Line 319: change "orc run-heartbeat (repeating, extends lease)" to "(protocol signal at lifecycle points)" in the Worker Lifecycle diagram.
- Line 382: remove or rewrite the "background heartbeat loop during the wait" reference to match PID-based liveness model.

### Step 4 — Add notes to configuration.md

**File:** `docs/configuration.md`

Add near the model configuration section:

```markdown
> **Note:** Model names in examples (e.g., `claude-sonnet-4-20250514`) reflect
> models available at time of writing and may change. Check your provider's
> documentation for current model identifiers.
```

Add near the provider defaults:

```markdown
> The master defaults to `claude` (optimized for interactive conversation)
> while workers default to `codex` (optimized for autonomous coding). Override
> both via config file or environment variables.
```

### Step 5 — Add CLI/MCP parity note to memory.md

**File:** `docs/memory.md`

Add between the CLI and MCP sections:

```markdown
> **Note:** The CLI commands and MCP tools are equivalent interfaces to the
> same underlying memory store. Use CLI from the terminal, MCP from agent
> tool calls — the results are identical.
```

### Step 6 — Add architecture link to adapters.md

**File:** `docs/adapters.md`

Add near the top:

```markdown
For how adapters fit into the overall system, see [Architecture](./architecture.md).
```

### Step 7 — Add "See also" footers to all human docs

Add a `## See also` section at the bottom of each human-facing doc linking to
2-3 most relevant related docs. Example for getting-started.md:

```markdown
## See also

- [Concepts & terminology](./concepts.md)
- [Configuration](./configuration.md)
- [CLI reference](./cli.md)
```

---

## Acceptance criteria

- [ ] README.md links to all 11 documentation files (9 existing + 2 new).
- [ ] getting-started.md line 158 heartbeat error is fixed.
- [ ] contracts.md heartbeat section (lines 274-295) matches AGENTS.md PID-based model.
- [ ] contracts.md no longer contains background heartbeat loop code example.
- [ ] configuration.md has model-name caveat and default-asymmetry explanation.
- [ ] memory.md has CLI/MCP parity note.
- [ ] adapters.md links to architecture.md.
- [ ] All human-facing docs have "See also" footers (including cli.md, recovery.md, troubleshooting.md).
- [ ] cli.md changes are limited to adding a "See also" footer only (content owned by Task 155).
- [ ] recovery.md and troubleshooting.md changes are limited to adding "See also" footers only (content owned by Task 156).
- [ ] contracts.md lines 319 and 382 also updated to match PID-based liveness model.
- [ ] No changes to files outside the stated scope.

---

## Tests

No code tests — documentation only.

---

## Verification

```bash
# Verify README links
grep -c '\./docs/' README.md  # should be >= 11

# Verify heartbeat fix
grep -q "4.5 minutes" docs/getting-started.md && echo "FAIL: old heartbeat text remains" || echo "OK"
grep -q "background loop" docs/contracts.md && echo "FAIL: old heartbeat loop remains" || echo "OK"
```
