---
ref: memory-quality/141-periodic-memory-pruning
feature: memory-quality
priority: normal
status: todo
depends_on:
  - memory-quality/139-memory-expiry-and-pruning
---

# Task 141 — Add Configurable Periodic Memory Pruning to Coordinator Tick

Independent (runtime dependency on Task 139 for prune functions).

## Scope

**In scope:**
- New `memory_prune_interval_ms` field in `CoordinatorConfig` (default `3600000` = 1 hour)
- Coordinator tick calls pruning when elapsed time since last prune exceeds the interval
- Config file, type definition, parser, defaults, and documentation updated
- CLI flag override `--memory-prune-interval-ms=<ms>`

**Out of scope:**
- Changing prune logic itself (`pruneExpiredMemories`, `pruneByCapacity` — Task 139)
- Removing the existing startup prune (keep it; periodic is additive)
- Adding new prune strategies (e.g., per-wing limits)

---

## Context

### Current state

Memory pruning (`pruneExpiredMemories` + `pruneByCapacity`) runs only once at
coordinator startup (`coordinator.ts:1774-1778`). If the coordinator runs
continuously for days or weeks without restart, expired memories linger and
rooms can exceed the 200-drawer capacity limit indefinitely.

### Desired state

The coordinator periodically prunes memory on a configurable interval (default
1 hour). The startup prune is retained. The interval is configurable via
`orchestrator.config.json` under `coordinator.memory_prune_interval_ms` and
overridable via CLI flag `--memory-prune-interval-ms`.

### Start here

- `coordinator.ts` — startup prune at ~line 1774, tick function at ~line 1150
- `lib/providers.ts` — `CoordinatorConfig` interface and defaults
- `docs/configuration.md` — coordinator config table

**Affected files:**
- `coordinator.ts` — add tick-based periodic prune with timestamp tracking
- `lib/providers.ts` — add `memory_prune_interval_ms` to `CoordinatorConfig`, default, and parser
- `docs/configuration.md` — document new field in coordinator table
- `orchestrator.config.json.example` (if it exists) — add field

---

## Goals

1. Must prune expired and over-capacity memories periodically during long coordinator runs.
2. Must be configurable via `coordinator.memory_prune_interval_ms` in config file.
3. Must be overridable via `--memory-prune-interval-ms` CLI flag.
4. Must default to `3600000` (1 hour).
5. Must retain the existing startup prune (additive, not replacement).
6. Must not prune on every tick — only when elapsed time exceeds the configured interval.
7. Must handle missing memory.db gracefully (no crash if memory system not initialized).

---

## Implementation

### Step 1 — Add config field to CoordinatorConfig

**File:** `lib/providers.ts`

Add `memory_prune_interval_ms: number` to the `CoordinatorConfig` interface.
Add default `memory_prune_interval_ms: 3_600_000` to `DEFAULT_COORDINATOR_CONFIG`.
Add parsing in `loadCoordinatorConfig()` using `parsePositiveInteger`.

### Step 2 — Add CLI flag and tick-based pruning to coordinator

**File:** `coordinator.ts`

1. Read the config value with CLI flag override:
   ```typescript
   const MEMORY_PRUNE_INTERVAL_MS = intFlag('memory-prune-interval-ms', COORD_CONFIG.memory_prune_interval_ms);
   ```

2. Add module-level timestamp tracker:
   ```typescript
   let lastMemoryPruneAt = Date.now(); // startup prune counts as first
   ```

3. Inside `tick()`, after the main dispatch/lifecycle logic, add:
   ```typescript
   if (Date.now() - lastMemoryPruneAt > MEMORY_PRUNE_INTERVAL_MS) {
     try {
       const expired = pruneExpiredMemories(STATE_DIR);
       const capped = pruneByCapacity(STATE_DIR);
       if (expired + capped > 0) log(`memory pruning: removed ${expired} expired, ${capped} over-capacity`);
       lastMemoryPruneAt = Date.now();
     } catch { /* memory system not initialized */ }
   }
   ```

   Place the timestamp update inside the try block so failed prunes are retried on the next tick.

### Step 3 — Document the new config field

**File:** `docs/configuration.md`

Add row to the `coordinator` table:

| `memory_prune_interval_ms` | integer | `3600000` | Interval between periodic memory pruning runs (ms). Set to `0` to disable periodic pruning (startup prune still runs). |

---

## Acceptance criteria

- [ ] `CoordinatorConfig` interface includes `memory_prune_interval_ms` with correct type.
- [ ] `DEFAULT_COORDINATOR_CONFIG` sets `memory_prune_interval_ms` to `3600000`.
- [ ] `loadCoordinatorConfig()` parses the field from config JSON.
- [ ] Coordinator reads `--memory-prune-interval-ms` CLI flag as override.
- [ ] Tick function calls pruning when elapsed time exceeds configured interval.
- [ ] Startup prune still runs (not removed or gated).
- [ ] Setting interval to `0` disables periodic pruning (startup prune still runs).
- [ ] Missing memory.db does not crash the coordinator tick.
- [ ] `docs/configuration.md` documents the new field.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/providers.test.ts`:

```typescript
it('parses memory_prune_interval_ms from config', () => { ... });
it('defaults memory_prune_interval_ms to 3600000', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/providers.test.ts
```

```bash
nvm use 24 && npm test
```

```bash
orc doctor
```

---

## Risk / Rollback

**Risk:** Minimal. Pruning functions already exist and are tested. This only changes when they're called.
**Rollback:** Revert the three affected files. Pruning reverts to startup-only behavior.
