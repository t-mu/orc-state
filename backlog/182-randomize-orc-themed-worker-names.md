---
ref: orc-names/182-randomize-orc-themed-worker-names
feature: orc-names
review_level: full
priority: normal
status: done
---

# Task 182 — Randomize Orc-Themed Worker Names

Independent.

## Scope

**In scope:**
- Replace the adjective and noun word lists in `lib/agentNames.ts` with orc-themed vocabulary (≥72 firsts, ≥88 seconds; asymmetric is fine).
- Change `nextAvailableAgentName(inUse, rng?)` to draw a random `(first, second)` pair, retry on collision, cap retries, then fall back to a deterministic scan before throwing on true pool exhaustion.
- Accept an optional seeded RNG argument for deterministic tests.
- Handle the `rng() === 1` boundary correctly so `Math.floor(rng() * N)` never equals `N`.
- Create `lib/agentNames.test.ts` with focused picker coverage.
- Rewrite the naming assertions in `lib/agentRegistry.test.ts` that currently expect the literal strings `amber-anchor` / `amber-anvil` — those assertions are specific to the deterministic scan and WILL fail after this change.
- Update narrative documentation: `AGENTS.md` (line ~99 reviewer-id example and the "Blessed Paths" worker-dispatch line), `docs/architecture.md`, `docs/contracts.md` (including the `pty:amber-kettle` example), `lib/agentRegistry.ts` JSDoc around `nextAvailableWorkerName`, and the comment in `lib/workerSlots.ts` describing the naming scheme.

**Out of scope:**
- Tracking retired worker names, session-scoped uniqueness, or any persistence of historical names. Uniqueness is guaranteed only among currently-active agents — a dead worker's name is free to reuse immediately (same behavior class as today).
- Scout IDs. Scouts use a separate sequential path (`nextAvailableScoutId`) that is not touched here.
- Test-fixture literal strings like `amber-anchor` used as scene-setting in unrelated test files (`coordinator.test.ts`, `harness.test.ts`, `statusView.test.ts`, TUI tests, etc.). Those are string fixtures, not naming assertions; leave them as-is.
- Configurable or provider-specific word lists.
- Cross-session guarantees.

---

## Context

Today `lib/agentNames.ts::nextAvailableAgentName(inUse)` iterates `FIRST_WORDS` outer and `SECOND_WORDS` inner, returning the first candidate not in `inUse`. The pool is 64 × 64 = 4096 combinations but the scan always starts at `amber-anchor`, so the first worker to spawn is always `amber-anchor`, the second `amber-anvil`, and so on. Live evidence from `orc status`: two concurrent workers, both `amber-*`.

The change is cosmetic in terms of correctness (uniqueness-among-active is already satisfied), but the lexicographic clustering makes logs, memories, and events harder to read at a glance. Randomizing the pick distributes names across the full pool. Swapping to orc-themed vocabulary aligns with the project's tone.

Uniqueness among currently-active agents is the only guarantee we keep. Reuse after worker death is fine — the `run_id` is the authoritative cross-reference identifier.

**Affected files:**
- `lib/agentNames.ts` — word lists and picker algorithm
- `lib/agentNames.test.ts` — NEW test file with focused picker coverage
- `lib/agentRegistry.test.ts` — rewrite the deterministic `nextAvailableWorkerName` assertions (currently around lines 231–255) to match randomized output (seeded RNG for exact assertions, or shape-based matchers)
- `lib/agentRegistry.ts` — update the JSDoc around `nextAvailableWorkerName` (line ~161–170) describing the naming scheme
- `lib/workerSlots.ts` — update the comment at line ~7 describing the naming scheme
- `AGENTS.md` — blessed-paths worker-dispatch line + reviewer-id example (`amber-kettle` → an orc-themed example)
- `docs/architecture.md`, `docs/contracts.md` — any narrative describing worker naming, including the `pty:amber-kettle` example around `docs/contracts.md:516`

---

## Goals

1. Must replace `FIRST_WORDS` and `SECOND_WORDS` with orc-themed vocabulary: ≥72 firsts and ≥88 seconds.
2. Must change `nextAvailableAgentName(inUse, rng?)` to pick a random `(first, second)` pair; retry on collision up to a bounded cap; fall back to a deterministic scan; throw a clear error only on true pool exhaustion.
3. Must accept an optional seeded RNG argument (type `() => number`) for deterministic tests. Default to `Math.random`.
4. Must clamp or guard against `rng()` returning exactly `1` so the picked index is always in `[0, N)`.
5. Must preserve the existing `nextAvailableWorkerName(stateDir)` caller signature in `lib/agentRegistry.ts`: it continues to pass only `inUse` to the picker (omitting `rng`).
6. Must create `lib/agentNames.test.ts` covering seeded-RNG determinism, boundary handling, collision retry, scan fallback, and exhaustion.
7. Must rewrite the existing `nextAvailableWorkerName` tests in `lib/agentRegistry.test.ts` whose assertions depend on the deterministic scan order.
8. Must update narrative documentation and JSDoc/comments listed in "Affected files" to describe the new random orc-themed picker. Test-fixture string literals elsewhere in the repo stay untouched.

---

## Implementation

### Step 1 — Replace word lists with orc-themed vocabulary

**File:** `lib/agentNames.ts`

Replace `FIRST_WORDS` and `SECOND_WORDS` with orc-flavored entries. Draw from:

- **Firsts (adjectives / -ing forms):** physical state (broken, cracked, scarred, gnarled, jagged, twisted, ragged, notched, battered, charred, mangled, chipped); action/-ing (slithering, howling, grinding, snarling, gnashing, lurking, stomping, bellowing, prowling, lumbering, rampaging, smoldering, reeking, roaring, crushing, cleaving, creeping, stalking); quality (foul, grim, gruff, feral, savage, brutal, hulking, filthy, wicked, dire, wretched, grisly, surly, murky, fierce, mighty, vile, rank); color/material (ashen, iron, rust, sallow, ruddy, tar, bloody, sooty, grimy, dusky, black).
- **Seconds (nouns):** body parts (nose, tooth, fang, fist, claw, jaw, skull, tusk, horn, maw, gullet, scar, spine, hoof, hide, throat, tongue, bone, knuckle, snout); weapons (arrow, blade, axe, club, spear, hammer, maul, dagger, mace, flail, cleaver, pike, cudgel, shard, hatchet, gauntlet, dirk, spike); gear (helm, shield, banner, chain, hook, torch, brand, cauldron, kettle, stake, cage, collar, rope); creatures (wolf, raven, crow, spider, rat, vulture, worm, serpent, boar, toad, bat, beetle, hyena, slug); terrain (swamp, bog, mire, cave, pit, crag, moor, fen, gorge, ash, smoke, mud, rot, mold, ember, coal, grave, tomb, cairn, ravine).

Occasional weird combinations (`slithering-cauldron`, `ashen-spider`) are acceptable — they're memorable. Drop the "4096 names" phrasing in the JSDoc; note the new asymmetric size and random-with-scan-fallback behavior.

### Step 2 — Randomize the picker with bounded retry and scan fallback

**File:** `lib/agentNames.ts`

```ts
/**
 * Return a random orc-themed `<first>-<second>` name not present in `inUse`.
 * Retries a bounded number of times on collision, then falls back to a
 * deterministic scan of the remaining pool. Throws only when the pool
 * (|FIRST_WORDS| × |SECOND_WORDS|) is fully exhausted.
 *
 * `rng` defaults to `Math.random` and must return a value in [0, 1). Values
 * equal to 1 are clamped so `Math.floor(rng() * N) < N` holds.
 */
export function nextAvailableAgentName(
  inUse: ReadonlySet<string>,
  rng: () => number = Math.random,
): string {
  const pickIndex = (n: number) => {
    const r = rng();
    const clamped = r >= 1 ? 0.9999999999 : r < 0 ? 0 : r;
    return Math.floor(clamped * n);
  };

  const retryCap = Math.min(FIRST_WORDS.length * SECOND_WORDS.length, 1024);
  for (let i = 0; i < retryCap; i++) {
    const first = FIRST_WORDS[pickIndex(FIRST_WORDS.length)];
    const second = SECOND_WORDS[pickIndex(SECOND_WORDS.length)];
    const candidate = `${first}-${second}`;
    if (!inUse.has(candidate)) return candidate;
  }

  // Near-exhaustion fallback: deterministic scan for any remaining free slot.
  for (const first of FIRST_WORDS) {
    for (const second of SECOND_WORDS) {
      const candidate = `${first}-${second}`;
      if (!inUse.has(candidate)) return candidate;
    }
  }

  throw new Error('exhausted agent name pool');
}
```

Key points:
- Two `rng()` calls per retry, in fixed order (first then second). Seeded tests must document this.
- Retry cap is `min(N*M, 1024)` — bounded regardless of pool size so the hot path never blows up on a near-full pool; the scan fallback handles long tails.
- `inUse` semantics are unchanged from today: currently-active agent names.

### Step 3 — Create `lib/agentNames.test.ts`

**File:** `lib/agentNames.test.ts` (NEW)

Cover:

```ts
it('returns a random orc-themed name in <first>-<second> form', () => { ... });
it('returns a deterministic name when given a seeded RNG', () => { ... });
it('handles rng() returning exactly 1 without picking an out-of-range index', () => { ... });
it('retries on collision and returns a name not in inUse', () => { ... });
it('falls back to scan when retries exhaust and still returns a free name', () => { ... });
it('throws when the pool is fully exhausted', () => { ... });
```

Provide a small seeded RNG helper (e.g. a Mulberry32 or simple LCG) inside the test file so determinism assertions are stable. Pin the seeded test's expected output to actual values — document in a comment that the expected names depend on the exact order of `rng()` calls inside the picker (first, then second).

### Step 4 — Rewrite deterministic naming assertions in `lib/agentRegistry.test.ts`

**File:** `lib/agentRegistry.test.ts`

The existing tests around `nextAvailableWorkerName` (currently around lines 231–255) assert `.toBe('amber-anchor')` / `.toBe('amber-anvil')`. These must change because:
- `amber-anchor` no longer exists (the word `amber` is gone).
- The order is no longer deterministic.

Replace the exact-string assertions with either:
- A shape-based matcher: `expect(name).toMatch(/^[a-z]+-[a-z]+$/)`.
- Or, where the test's intent is to prove uniqueness across multiple calls with a growing `inUse`, a seeded-RNG path that lets the test assert exact names.

Keep the test coverage intent intact: uniqueness among active agents, no collision with existing names in `agents.json`. Only the concrete assertions change.

### Step 5 — Update narrative documentation and in-source comments

**File:** `AGENTS.md`

- Update the Blessed Paths line describing worker dispatch: change "Workers are assigned a deterministic two-word name (e.g., `amber-kettle`), unique among active workers." to "Workers are assigned a random orc-themed two-word name (e.g., `broken-nose`, `slithering-arrow`), unique among currently-active workers."
- Update the reviewer-id example (currently around line 99 using `amber-kettle`) to use an orc-themed example; the example is still illustrating that `--agent-id` must match the worker's own id, not a reviewer label — the change is cosmetic.

**Files:** `docs/architecture.md`, `docs/contracts.md`

- Grep each for `amber-kettle`, `amber-anchor`, "deterministic two-word", "worker name"; update any narrative description to match AGENTS.md.
- In `docs/contracts.md` the `pty:amber-kettle` session-handle example (around line 516) should update the handle literal to match an orc-themed name.

**File:** `lib/agentRegistry.ts`

- Update the JSDoc block around `nextAvailableWorkerName` (line ~161–170) that says "deterministic two-word worker name" to reflect the randomized orc-themed picker.

**File:** `lib/workerSlots.ts`

- Update the comment at line ~7 that references "deterministic two-word names (e.g. `amber-anchor`)".

---

## Acceptance criteria

- [ ] `FIRST_WORDS` has ≥72 entries and `SECOND_WORDS` has ≥88 entries, all orc-themed.
- [ ] Plausible names like `broken-nose`, `slithering-arrow`, `iron-fang`, and `reeking-bog` exist in the combination space.
- [ ] `nextAvailableAgentName(inUse)` returns a random pick not in `inUse` using `Math.random` by default.
- [ ] `nextAvailableAgentName(inUse, rng)` with a seeded RNG returns a deterministic value; the test asserts an exact expected name.
- [ ] When `rng()` returns exactly `1`, the picker does not access an out-of-range index.
- [ ] Given a `used` set covering 99% of the pool, the function returns a valid free name via the scan fallback.
- [ ] Given a `used` set covering the full pool, the function throws `'exhausted agent name pool'`.
- [ ] The existing `nextAvailableWorkerName(stateDir)` caller in `lib/agentRegistry.ts` compiles and behaves identically (passes only `inUse`, default RNG).
- [ ] `lib/agentNames.test.ts` exists and covers the scenarios above.
- [ ] `lib/agentRegistry.test.ts` no longer asserts the literal names `amber-anchor` / `amber-anvil`; replacement assertions use shape matchers or seeded-RNG exact matchers.
- [ ] `AGENTS.md`, `docs/architecture.md`, `docs/contracts.md`, `lib/agentRegistry.ts` JSDoc, and `lib/workerSlots.ts` comment all describe the new randomized orc-themed naming scheme; no stale `amber-kettle` / `amber-anchor` narrative references remain in these files.
- [ ] Test-fixture string literals in unrelated test files (`coordinator.test.ts`, `harness.test.ts`, `statusView.test.ts`, TUI tests, etc.) are NOT modified — they are scene-setting fixtures, not naming assertions.
- [ ] `npm test` passes.
- [ ] No changes to files outside the "Affected files" list above.

---

## Tests

Create `lib/agentNames.test.ts`:

```ts
it('returns a random orc-themed name in <first>-<second> form', () => { ... });
it('returns a deterministic name when given a seeded RNG', () => { ... });
it('handles rng() returning exactly 1 without picking an out-of-range index', () => { ... });
it('retries on collision and returns a name not in inUse', () => { ... });
it('falls back to scan when retries exhaust and still returns a free name', () => { ... });
it('throws when the pool is fully exhausted', () => { ... });
```

Update `lib/agentRegistry.test.ts`: replace `toBe('amber-anchor')` / `toBe('amber-anvil')` assertions with shape-based or seeded-RNG assertions. Preserve the original test intents (uniqueness among active, no collision with `agents.json`).

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
orc backlog-sync-check --refs=orc-names/182-randomize-orc-themed-worker-names
```
