---
ref: publish/110-troubleshooting-doc
feature: publish
priority: normal
status: done
---

# Task 110 — Add Troubleshooting Doc and Link Docs from README

Independent.

## Scope

**In scope:**
- Create `docs/troubleshooting.md` covering common consumer issues
- Add explicit link to `docs/` directory from `README.md`
- Cover: provider not found, auth failure, not a git repo, worktree errors, coordinator crash, stale claims

**Out of scope:**
- Rewriting the existing README content
- Changing other docs files
- Adding a glossary (separate task if needed)

---

## Context

### Current state

The `docs/` directory has `getting-started.md`, `cli.md`, `configuration.md`, `adapters.md`, and `contracts.md`. There is no troubleshooting guide. README.md does not explicitly link to the `docs/` directory. When users hit common errors (provider not found, auth failure, worktree issues), they have no documented recovery path.

### Desired state

A `docs/troubleshooting.md` file exists with structured problem/solution entries for common issues. README.md includes a "Documentation" section linking to `docs/` subdirectory.

### Start here

- `docs/` — existing documentation directory
- `README.md` — landing page for consumers
- `cli/doctor.ts` — to understand what errors it surfaces

**Affected files:**
- `docs/troubleshooting.md` — new file
- `README.md` — add docs link section

---

## Goals

1. Must cover at least 6 common error scenarios with problem/cause/solution format
2. Must include provider-specific setup guidance (where to get API keys)
3. Must link from README.md to docs/ directory
4. Must be accurate to current code behavior

---

## Implementation

### Step 1 — Create troubleshooting doc

**File:** `docs/troubleshooting.md`

Structure as a series of problem entries:

```markdown
# Troubleshooting

## "Provider 'X' binary not found on PATH"
**Cause:** ...
**Fix:** ...

## "Must run inside a git repository"
**Cause:** ...
**Fix:** ...

## Provider authentication failures
**Cause:** ...
**Fix:** ...
```

Cover these scenarios:
1. Provider binary not found
2. Provider authentication failure
3. Not inside a git repository
4. Worktree creation failures
5. Coordinator crash / stale coordinator
6. Stale claims / expired leases
7. Worker stuck or unresponsive

### Step 2 — Add docs link to README

**File:** `README.md`

Add a "Documentation" section near the top (after "Getting started") linking to:
- `docs/getting-started.md`
- `docs/cli.md`
- `docs/configuration.md`
- `docs/troubleshooting.md`

---

## Acceptance criteria

- [ ] `docs/troubleshooting.md` exists with at least 6 problem/solution entries
- [ ] Each entry has Problem, Cause, and Fix sections
- [ ] Provider setup guidance covers Claude, Codex, and Gemini
- [ ] README.md links to `docs/` directory with at least 4 doc links
- [ ] No factual errors relative to current code behavior
- [ ] No changes to files outside the stated scope

---

## Tests

No code tests — documentation only. Manual review for accuracy.

---

## Verification

```bash
# Verify files exist
ls docs/troubleshooting.md
grep -q 'troubleshooting' README.md
```

```bash
nvm use 24 && npm test
# Expected: no regressions
```
