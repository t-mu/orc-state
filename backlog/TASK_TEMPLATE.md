---
ref: <feature>/<slug>
feature: <feature-ref>
review_level: full
priority: normal
status: todo
---

# Task <N> — <Imperative Title>

Independent.
<!-- Replace with a dependency line when needed, e.g.: "Depends on Task N-1. Blocks Task N+1." -->

## Scope

**In scope:**
- <!-- One concrete outcome per bullet. -->

**Out of scope:**
- <!-- Explicit exclusions. Name specific files, systems, or concerns that must not change. -->

---

## Context

<!-- Why this change is needed. What breaks or is missing without it.
     Link to related tasks, prior work, or the spec that motivates this. -->

### Current state

<!-- 2-5 lines describing how the relevant system behaves today.
     State the current limitation, bug, or missing capability plainly. -->

### Desired state

<!-- 2-5 lines describing the intended end state after this task lands.
     Make the before/after delta obvious. -->

### Start here

<!-- 1-3 concrete files to inspect first. Use this to give a fresh worker an
     immediate entry point into the codebase. -->

- `path/to/file.mjs` — <!-- first file to inspect -->

<!-- Optional:
### Dependency context

Include only when this task depends on prior work in a way that would not
be obvious from the code alone. Summarize the needed baseline in 2-4 lines
instead of sending the worker to read older tasks.
-->

**Affected files:**
- `path/to/file.mjs` — <!-- what role this file plays -->

---

## Goals

<!-- 3–7 "must" statements. Each must be independently verifiable. -->

1. Must ...
2. Must ...
3. Must ...

---

## Implementation

<!-- Ordered, atomic steps. Each step touches one file or one concern.
     Include exact file paths, expected code shape, and any invariants to preserve.
     Call out files that must remain unchanged. -->

### Step 1 — <description>

**File:** `path/to/file.mjs`

```js
// expected shape or diff
```

<!-- Invariant: do not modify X -->

### Step 2 — ...

---

## Acceptance criteria

<!-- Binary checklist. Each item tied to observable behavior.
     Include at least one failure/edge-case item. -->

- [ ] ...
- [ ] ...
- [ ] Exits with code 1 and a descriptive message when <failure condition>.
- [ ] No changes to files outside the stated scope.

---

## Tests

<!-- Exact test descriptions to add or update. Reference the test file path.
     Follow the pattern in existing *.test.mjs / *.test.ts files. -->

Add to `path/to/file.test.mjs`:

```js
it('<description>', () => { ... });
```

---

## Verification

```bash
# Targeted verification for this task only
# Prefer the narrowest commands that prove the change works.
npx vitest run path/to/targeted.test.mjs
```

```bash
# Final required repo-wide checks before marking the task done
nvm use 24 && npm test
```

```bash
# Smoke checks — include only when schema, state, or CLI changes are in scope
orc doctor
orc status
# Expected: exits 0, no validation errors
```

---

## Risk / Rollback

<!-- Required when the task: mutates state files, changes a JSON schema,
     adds/removes npm scripts, or has partial-write failure modes.
     Omit only for pure code changes with no stateful side effects. -->

**Risk:** <!-- What can go wrong. -->
**Rollback:** <!-- How to recover. E.g. "revert backlog.json from git; re-run orc:doctor." -->
