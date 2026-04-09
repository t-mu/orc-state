---
ref: general/155-docs-cli-complete
feature: general
priority: high
status: todo
---

# Task 155 — Complete docs/cli.md CLI Reference

Independent.

## Scope

**In scope:**
- Add 4 missing memory commands to `docs/cli.md`
- Fix inaccurate heartbeat description (line 37)
- Add per-command flags/arguments for all commands
- Add usage examples for commonly-used commands
- Mark which commands are operator-facing vs agent-only

**Out of scope:**
- Renaming commands (all names are already correct)
- Changing command behavior or implementation
- Other documentation files (Task 157 handles cross-linking)

---

## Context

`docs/cli.md` covers 48 of 52 commands but has three gaps:

1. **Missing memory commands.** The 4 memory commands (`memory-status`,
   `memory-search`, `memory-wake-up`, `memory-record`) are not listed anywhere
   in cli.md. They are documented in `docs/memory.md` but not discoverable
   from the CLI reference.

2. **Inaccurate heartbeat description.** Line 37 says: "Extend the claim lease
   (must fire at least every 5 minutes)." Per AGENTS.md, heartbeat is a
   protocol signal at key lifecycle points (before reviewers, before rebase,
   before work-complete). Liveness is determined by PID probing, not heartbeat
   timing.

3. **No flags or arguments documented.** Every command row has only a one-line
   description. No flags, arguments, or usage examples.

All 52 command names in `cli/orc.ts` are correctly named — no renaming is
needed. Only the 4 missing memory commands need to be added.

**Start here:** `docs/cli.md`

**Affected files:**
- `docs/cli.md` — existing file, add content

---

## Goals

1. Must add a Memory section with all 4 memory commands.
2. Must fix the heartbeat description to match AGENTS.md.
3. Must add flags/arguments for all commands that accept them.
4. Must add usage examples for at least the 10 most commonly-used commands.
5. Must indicate which commands are typically called by agents vs operators.

---

## Implementation

### Step 1 — Add Memory section

**File:** `docs/cli.md`

Add after the Monitoring section (after line 63):

```markdown
## Memory

| Command | Description |
|---------|-------------|
| `memory-status` | Show memory store statistics (drawer count, DB size, FTS5 health). |
| `memory-search <query>` | Full-text search across memory drawers. |
| `memory-wake-up` | Recall essential memories for session context. |
| `memory-record --content="..."` | Store a new memory in the spatial taxonomy. |
```

### Step 2 — Fix heartbeat description

**File:** `docs/cli.md`

Change line 37 from:
```
| `run-heartbeat` | Extend the claim lease (must fire at least every 5 minutes). |
```
to:
```
| `run-heartbeat` | Protocol signal emitted at key lifecycle points (before reviewers, rebase, work-complete). |
```

### Step 3 — Add flags and arguments

**File:** `docs/cli.md`

For each command that accepts flags, add a details row or sub-table below the
main table. Example for `run-fail`:

```markdown
| `run-fail` | Terminal failure signal. Optionally requeues or blocks the task. |

**Flags:** `--run-id=<id>` `--agent-id=<id>` `--reason=<text>` `--policy=requeue|block`
```

Verify flags by reading the corresponding `cli/<command>.ts` file for each command.

### Step 4 — Add usage examples

Add an "Examples" subsection at the end with common workflows:

```markdown
## Examples

### Start a session
\`\`\`bash
orc init --provider=claude
orc start-session
\`\`\`

### Check system health
\`\`\`bash
orc status
orc doctor
\`\`\`

### Reset a stuck task
\`\`\`bash
orc task-reset general/42-my-task
\`\`\`
```

### Step 5 — Mark operator vs agent commands

Add a note at the top of the Worker lifecycle section:

```markdown
> **Note:** These commands are typically called by worker agents, not by human
> operators. They are documented here for completeness and debugging.
```

Similarly mark the MCP server command and review commands.

---

## Acceptance criteria

- [ ] Memory section exists with all 4 memory commands.
- [ ] Heartbeat description (line 37) corrected to "protocol signal at key lifecycle points."
- [ ] Per-command flags/arguments documented for commands that accept them.
- [ ] Usage examples section exists with at least 5 common workflows.
- [ ] Agent-only command sections have a note indicating they're not for operators.
- [ ] All 52 commands from `cli/orc.ts` are represented.
- [ ] No changes to files outside the stated scope.

---

## Tests

No code tests — documentation only.

Verify command count:
```bash
grep -c '| `' docs/cli.md  # should be >= 52
```

---

## Verification

```bash
test -s docs/cli.md && echo "OK"
```
