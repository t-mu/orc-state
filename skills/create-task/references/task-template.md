---
ref: <feature>/<slug>
feature: <feature-ref>
---

# Task <N> — <Imperative Title>

<!-- Dependency note, e.g.: "Independent." or "Depends on Task N-1. Blocks Task N+1." -->

## Scope

**In scope:**
- <!-- One concrete outcome per bullet. Name the file or function. -->

**Out of scope:**
- <!-- Explicit exclusions. Name specific files, systems, or concerns that must not change. -->

---

## Context

<!-- Why this change is needed. What breaks or is missing without it.
     Show the buggy/missing code when relevant. Link to related tasks or specs. -->

**Affected files:**
- `path/to/file.mjs` — <!-- role this file plays -->

---

## Goals

<!-- 3–7 "Must" statements. Each must be independently verifiable. -->

1. Must ...
2. Must ...
3. Must ...

---

## Implementation

<!-- Ordered, atomic steps. Each step touches one file or one concern. -->

### Step 1 — <description>

**File:** `path/to/file.mjs`

```js
// expected shape, diff, or before/after block
```

<!-- Invariant: do not modify X -->

### Step 2 — <description>

**File:** `path/to/file.mjs`

```js
// ...
```

---

## Acceptance criteria

<!-- Binary checklist. Each item tied to observable behaviour.
     Include at least one failure/edge-case item. -->

- [ ] ...
- [ ] ...
- [ ] Exits with code 1 and a descriptive message when <failure condition>.
- [ ] No changes to files outside the stated scope.

---

## Tests

<!-- Name exact test descriptions and file paths. Show the it(...) call shape. -->

Add to `path/to/file.test.mjs`:

```js
it('<description>', () => { ... });
```

---

## Verification

```bash
# Full suite
nvm use 24 && npm test

# Orchestrator only (faster, when change is scoped to orchestrator/)
nvm use 24 && npm test
```

```bash
# Smoke — include only when task touches schemas, state files, or CLI commands
npm run orc:doctor
npm run orc:status
# Expected: exits 0, no validation errors
```

---

## Risk / Rollback

<!-- Include when the task: mutates state files, changes a JSON schema,
     adds/removes npm scripts, or has partial-write failure modes.
     Omit for pure code changes with no stateful side effects. -->

**Risk:** <!-- What can go wrong. -->
**Rollback:** <!-- How to recover. E.g. "git restore path/to/file.mjs && npm test" -->
