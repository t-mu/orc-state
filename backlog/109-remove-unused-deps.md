---
ref: publish/109-remove-unused-deps
feature: publish
priority: low
status: todo
---

# Task 109 — Remove Unused Dependencies `boxen` and `ink-spinner`

Independent.

## Scope

**In scope:**
- Remove `boxen` and `ink-spinner` from `package.json` `dependencies`
- Verify no source file imports either package

**Out of scope:**
- Adding new dependencies
- Refactoring code that might have used these packages
- Changing `devDependencies`

---

## Context

### Current state

`boxen@8.0.1` and `ink-spinner@5.0.0` are listed in `dependencies` but neither is imported in any source file or compiled output. They add ~50KB to install size unnecessarily.

### Desired state

Both packages removed from `dependencies`. Install footprint reduced.

### Start here

- `package.json` — dependencies section

**Affected files:**
- `package.json` — remove two entries from `dependencies`

---

## Goals

1. Must remove `boxen` from `dependencies`
2. Must remove `ink-spinner` from `dependencies`
3. Must verify no source file imports either package before removal
4. Must pass full test suite after removal

---

## Implementation

### Step 1 — Verify no imports exist

```bash
grep -r "from 'boxen'" --include='*.ts' .
grep -r "from 'ink-spinner'" --include='*.ts' .
grep -r "require('boxen')" --include='*.ts' .
grep -r "require('ink-spinner')" --include='*.ts' .
# Expected: no matches (excluding node_modules)
```

### Step 2 — Remove from package.json

**File:** `package.json`

Remove these lines from the `dependencies` object:
```json
"boxen": "8.0.1",
"ink-spinner": "5.0.0",
```

### Step 3 — Reinstall

```bash
npm install
```

---

## Acceptance criteria

- [ ] `boxen` not in `package.json` `dependencies`
- [ ] `ink-spinner` not in `package.json` `dependencies`
- [ ] `grep -r "from 'boxen'" --include='*.ts' .` returns no matches
- [ ] `grep -r "from 'ink-spinner'" --include='*.ts' .` returns no matches
- [ ] `npm test` passes
- [ ] No changes to files outside the stated scope

---

## Tests

No new tests needed — this is a dependency removal.

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
npm pack --dry-run 2>&1 | head -5
# Expected: smaller tarball size
```
