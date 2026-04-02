---
ref: publish/112-fix-readme-and-cli-docs
feature: publish
priority: normal
status: todo
---

# Task 112 — Fix README Entry Points and CLI Docs Gaps

Independent.

## Scope

**In scope:**
- Add `install` command to `docs/cli.md` (currently missing — it's a blessed command in `orc --help`)
- Align README quick start with `orc init` as the first-time entry point
- Remove stale `<!-- TODO: screenshot or GIF of orc watch TUI -->` comment from README

**Out of scope:**
- Changing `package.json` (separate task 111)
- Modifying any runtime code
- Adding actual screenshot/GIF content
- Rewriting getting-started.md (it already mentions `orc init`)

---

## Context

Two critic sub-agents found three documentation issues:

1. `docs/cli.md` lists `install-skills` and `install-agents` under "Setup" but omits the unified `install` command, which is a blessed command visible in `orc --help`.
2. README says `orc start-session --provider=claude` as the first step, but `docs/getting-started.md` says `orc init`. New users see two different first-run paths with no explanation of when to use which.
3. A stale TODO HTML comment is visible as a blank gap in the rendered README.

### Current state

- `docs/cli.md` Setup section has `install-agents` and `install-skills` but no `install`
- README quick start: `npm install -g orc-state` → `orc start-session --provider=claude`
- README line 11: `<!-- TODO: screenshot or GIF of orc watch TUI -->`

### Desired state

- `docs/cli.md` Setup section includes `install`
- README quick start shows both `orc init` (first time) and `orc start-session` (subsequent runs)
- TODO comment removed

### Start here

- `README.md` — quick start section and TODO comment
- `docs/cli.md` — Setup section at bottom of file

**Affected files:**
- `README.md` — quick start and TODO comment
- `docs/cli.md` — Setup table

---

## Goals

1. Must add `install` command to `docs/cli.md` with a one-line description.
2. Must update README quick start to show `orc init` as first-time setup and `orc start-session` for subsequent runs.
3. Must remove the TODO screenshot comment from README.
4. Must not introduce broken markdown or links.

---

## Implementation

### Step 1 — Add install to cli.md

**File:** `docs/cli.md`

In the Setup section, add `install` to the table:

```markdown
| `install` | Install skills, agents, and MCP config for configured providers. |
```

### Step 2 — Update README quick start

**File:** `README.md`

Replace the current quick start block:

```markdown
## Getting started

Requires Node.js 24+

```bash
npm install -g orc-state
orc start-session --provider=claude  # or codex, gemini
```

See [full documentation](./docs/) for configuration and usage.
```

With:

```markdown
## Getting started

Requires Node.js 24+

```bash
npm install -g orc-state
cd my-project
orc init                              # first-time setup
orc start-session --provider=claude   # start orchestrating
```

See [full documentation](./docs/) for configuration and usage.
```

### Step 3 — Remove TODO comment

**File:** `README.md`

Delete the line:
```
<!-- TODO: screenshot or GIF of orc watch TUI -->
```

---

## Acceptance criteria

- [ ] `docs/cli.md` contains `install` in the Setup table.
- [ ] README quick start shows `orc init` and `orc start-session` as separate steps.
- [ ] README contains no `<!-- TODO` comments.
- [ ] All markdown renders correctly (no broken tables or links).
- [ ] `npm test` passes.
- [ ] No changes to files outside `README.md` and `docs/cli.md`.

---

## Tests

Not applicable — task output is documentation text, not executable code.

---

## Verification

```bash
# Verify install in cli.md
grep 'install' docs/cli.md

# Verify README has both commands
grep 'orc init' README.md
grep 'orc start-session' README.md

# Verify no TODO comments
grep -c 'TODO' README.md
# Expected: 0

# Full suite
nvm use 24 && npm test
```
