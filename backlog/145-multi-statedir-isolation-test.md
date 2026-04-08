---
ref: memory-quality/145-multi-statedir-isolation-test
feature: memory-quality
priority: normal
status: done
depends_on:
  - memory-quality/142-multi-statedir-singleton
---

# Task 145 — Add Multi-stateDir Isolation Test

Depends on Task 142.

## Scope

**In scope:**
- Add integration test verifying operations across two stateDirs do not interfere
- Test covers store, search, and wake-up across isolated directories

**Out of scope:**
- Worker threads or multi-process concurrency testing (better-sqlite3 is synchronous)
- Modifying any production code
- Performance or stress testing

---

## Context

### Current state

The memory system has no test verifying that two simultaneous stateDir connections
produce fully isolated results. After Task 142 replaces the singleton with a Map,
this isolation property becomes testable and important to validate.

### Desired state

An integration test creates two temp stateDirs, performs store/search/wake-up operations
on each, and verifies zero cross-contamination.

### Start here

- `lib/memoryStore.integration.test.ts` — existing integration tests for pattern reference
- `test-fixtures/stateHelpers.ts` — `createTempStateDir` / `cleanupTempStateDir`

**Affected files:**
- `lib/memoryStore.integration.test.ts` — add one new test

---

## Goals

1. Must verify that a drawer stored in stateDir A is not searchable from stateDir B.
2. Must verify that wake-up from stateDir A does not surface memories from stateDir B.
3. Must properly clean up both temp directories.

---

## Implementation

### Step 1 — Add isolation test

**File:** `lib/memoryStore.integration.test.ts`

Add a new test case:

```typescript
it('operations across two stateDirs do not interfere', () => {
  const dir2 = createTempStateDir('orch-memory-isolation-');
  try {
    initMemoryDb(dir);
    initMemoryDb(dir2);

    storeDrawer(dir, { hall: 'h', room: 'r', content: 'dir1 specific content searchable' });
    storeDrawer(dir2, { hall: 'h', room: 'r', content: 'dir2 specific content searchable' });

    const results1 = searchMemory(dir, { query: 'searchable' });
    const results2 = searchMemory(dir2, { query: 'searchable' });

    expect(results1.length).toBe(1);
    expect(results1[0]?.snippet).toContain('dir1');
    expect(results2.length).toBe(1);
    expect(results2[0]?.snippet).toContain('dir2');

    // Wake-up isolation
    const wake1 = memoryWakeUp(dir);
    const wake2 = memoryWakeUp(dir2);
    expect(wake1).toContain('dir1');
    expect(wake1).not.toContain('dir2');
    expect(wake2).toContain('dir2');
    expect(wake2).not.toContain('dir1');
  } finally {
    closeMemoryDb(dir2);
    cleanupTempStateDir(dir2);
  }
});
```

Note: `searchMemory` must be added to the import list at the top of the file if not
already imported.

---

## Acceptance criteria

- [ ] Test stores a drawer in each of two stateDirs.
- [ ] Search in dir1 returns only dir1's drawer; search in dir2 returns only dir2's.
- [ ] Wake-up from dir1 contains only dir1 content; dir2 only dir2 content.
- [ ] Both temp directories are cleaned up (in `finally` block).
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/memoryStore.integration.test.ts`:

```typescript
it('operations across two stateDirs do not interfere', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/memoryStore.integration.test.ts
```

```bash
nvm use 24 && npm test
```
