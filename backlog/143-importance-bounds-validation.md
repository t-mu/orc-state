---
ref: memory-quality/143-importance-bounds-validation
feature: memory-quality
priority: normal
status: todo
---

# Task 143 — Validate Importance Bounds in storeDrawer and updateDrawerImportance

Independent.

## Scope

**In scope:**
- Add `clampImportance` helper to `lib/memoryStore.ts`
- Apply clamping in `storeDrawer()` and `updateDrawerImportance()`
- Tests for edge cases: NaN, Infinity, negative, >10, fractional

**Out of scope:**
- Changing the importance column type or schema
- Modifying CLI argument parsing (CLI already passes through to the library)
- Adding importance validation to MCP handlers (library-level validation is sufficient)

---

## Context

### Current state

`updateDrawerImportance()` (line 154) and `storeDrawer()` (line 135) accept any number
for importance without validation. Values like NaN, -5, or 999 are stored directly.
Importance is used in search ranking math: `bm25(drawers_fts) * (d.importance / 10.0)`.
NaN importance produces NaN rank, which corrupts search result ordering. Negative values
invert the ranking logic.

### Desired state

Both functions clamp importance to the integer range 1–10. NaN, Infinity, and undefined
default to 5. Fractional values are rounded. The clamping happens at the library level
so all callers (CLI, MCP, coordinator) benefit.

### Start here

- `lib/memoryStore.ts` — `storeDrawer` (line 124), `updateDrawerImportance` (line 154)

**Affected files:**
- `lib/memoryStore.ts` — add `clampImportance`, apply in two functions
- `lib/memoryStore.test.ts` — add importance validation tests

---

## Goals

1. Must clamp importance to integer range 1–10.
2. Must default NaN, Infinity, and undefined to 5.
3. Must round fractional values before clamping.
4. Must apply validation in both `storeDrawer` and `updateDrawerImportance`.
5. Must check `Number.isFinite` before `Math.round` to prevent NaN propagation.

---

## Implementation

### Step 1 — Add clampImportance helper

**File:** `lib/memoryStore.ts`

Add after the `wingFromTaskRef` function (~line 122), before `storeDrawer`, as a non-exported helper:

```typescript
function clampImportance(value: number | undefined): number {
  if (value === undefined) return 5;
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(10, Math.round(value)));
}
```

Order is critical: the `Number.isFinite` check must precede `Math.round` because
`Math.round(NaN)` returns `NaN` which poisons `Math.max`/`Math.min`.

### Step 2 — Apply in storeDrawer

**File:** `lib/memoryStore.ts`

In `storeDrawer` (line 135), replace:
```typescript
input.importance ?? 5
```
with:
```typescript
clampImportance(input.importance)
```

### Step 3 — Apply in updateDrawerImportance

**File:** `lib/memoryStore.ts`

In `updateDrawerImportance` (line 156), add clamping before the UPDATE:
```typescript
export function updateDrawerImportance(stateDir: string, id: number, importance: number): boolean {
  const db = getMemoryDb(stateDir);
  const clamped = clampImportance(importance);
  const result = db.prepare('UPDATE drawers SET importance = ? WHERE id = ?').run(clamped, id);
  return result.changes > 0;
}
```

### Step 4 — Add tests

**File:** `lib/memoryStore.test.ts`

Add a new `describe('importance validation')` block:

```typescript
it('storeDrawer clamps importance > 10 to 10', () => { ... });
it('storeDrawer clamps negative importance to 1', () => { ... });
it('storeDrawer defaults NaN importance to 5', () => { ... });
it('storeDrawer defaults Infinity importance to 5', () => { ... });
it('storeDrawer rounds fractional importance', () => { ... });
it('updateDrawerImportance clamps out-of-range values', () => { ... });
```

---

## Acceptance criteria

- [ ] `storeDrawer({..., importance: 15})` stores importance as 10.
- [ ] `storeDrawer({..., importance: -3})` stores importance as 1.
- [ ] `storeDrawer({..., importance: NaN})` stores importance as 5.
- [ ] `storeDrawer({..., importance: Infinity})` stores importance as 5.
- [ ] `storeDrawer({..., importance: 7.6})` stores importance as 8.
- [ ] `updateDrawerImportance(dir, id, 20)` updates importance to 10.
- [ ] `updateDrawerImportance(dir, id, -5)` updates importance to 1.
- [ ] All existing tests pass unchanged.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/memoryStore.test.ts`:

```typescript
describe('importance validation', () => {
  it('storeDrawer clamps importance > 10 to 10', () => { ... });
  it('storeDrawer clamps negative importance to 1', () => { ... });
  it('storeDrawer defaults NaN importance to 5', () => { ... });
  it('storeDrawer defaults Infinity importance to 5', () => { ... });
  it('storeDrawer rounds fractional importance', () => { ... });
  it('updateDrawerImportance clamps out-of-range values', () => { ... });
});
```

---

## Verification

```bash
npx vitest run lib/memoryStore.test.ts
```

```bash
nvm use 24 && npm test
```
