---
ref: general/161-pr-merge-config-schema
feature: general
priority: high
status: done
review_level: full
---

# Task 161 — Add merge_strategy Config, Schema, and Types

Independent.

## Scope

**In scope:**
- Add `merge_strategy` and PR-related fields to `CoordinatorConfig` in `lib/providers.ts`
- Add `merge_strategy` optional field to Task in `schemas/backlog.schema.json` and `types/backlog.ts`
- Add PR finalization states and PR claim fields to `schemas/claims.schema.json` and `types/claims.ts`
- Parse `merge_strategy` from task spec frontmatter via `lib/backlogSync.ts` and `lib/taskSpecReader.ts`
- Document all new config fields in `docs/configuration.md`
- Add `merge_strategy` to `backlog/TASK_TEMPLATE.md` frontmatter

**Out of scope:**
- Git host adapter implementation (Task 162)
- PR CLI commands (Task 163)
- Template files (Task 164)
- Coordinator finalization logic (Task 165)
- Worker protocol or AGENTS.md changes (Task 166)

---

## Context

The orchestrator currently only supports direct worktree merges. Adding a PR-based
merge strategy requires schema and config foundations before the coordinator logic
can branch on strategy. This task lays that foundation.

`merge_strategy` follows the same pattern as `review_level`: global default in
config, overridable per task in frontmatter. Resolution: `task.merge_strategy ??
config.merge_strategy ?? 'direct'`.

The PR finalization path introduces new claim states beyond the existing direct-mode
states (`awaiting_finalize`, `finalize_rebase_requested`, `finalize_rebase_in_progress`,
`ready_to_merge`, `blocked_finalize`). The new states are: `pr_created`,
`pr_review_in_progress`, `pr_merged`, `pr_failed`.

The reviewer worker owns the entire PR lifecycle — review, fix, rebase, CI, merge.
The coordinator spawns the reviewer, monitors its completion, and cleans up after.
No `pr_ci_pending` state — the coordinator doesn't poll CI separately.

**Start here:** `lib/providers.ts` line 40 (`CoordinatorConfig` interface)

**Affected files:**
- `lib/providers.ts` — config interface and defaults
- `schemas/backlog.schema.json` — Task definition
- `types/backlog.ts` — Task type
- `schemas/claims.schema.json` — FinalizationState enum and Claim fields
- `types/claims.ts` — Claim type
- `lib/backlogSync.ts` — frontmatter parsing and sync
- `lib/taskSpecReader.ts` — spec reader
- `docs/configuration.md` — documentation
- `backlog/TASK_TEMPLATE.md` — template frontmatter

---

## Goals

1. Must add `merge_strategy`, `pr_provider`, `pr_push_remote`, `pr_finalize_lease_ms` to `CoordinatorConfig`.
2. Must default `merge_strategy` to `'direct'` — no behavior change for existing users.
3. Must add `merge_strategy` as optional field on Task (schema + type).
4. Must add PR finalization states (`pr_created`, `pr_review_in_progress`, `pr_merged`, `pr_failed`) to FinalizationState enum.
5. Must add `pr_ref`, `pr_created_at`, `pr_reviewer_agent_id` to Claim (schema + type).
6. Must parse `merge_strategy` from task spec frontmatter following the `review_level` pattern.
7. Must pass `orc doctor` after all schema changes.

---

## Implementation

### Step 1 — Add config fields to lib/providers.ts

**File:** `lib/providers.ts`

Add to `CoordinatorConfig` interface (after line 48, `worker_stale_force_fail_ms`):

```typescript
merge_strategy: 'direct' | 'pr';
pr_provider: 'github' | null;
pr_push_remote: string;
pr_finalize_lease_ms: number;
```

Add to `DEFAULT_COORDINATOR_CONFIG`:

```typescript
merge_strategy: 'direct' as const,
pr_provider: null,
pr_push_remote: 'origin',
pr_finalize_lease_ms: 86_400_000,
```

Add parsing in `loadCoordinatorConfig()`.

### Step 2 — Add merge_strategy to backlog schema and type

**File:** `schemas/backlog.schema.json`

Add to Task properties (after `review_level`):

```json
"merge_strategy": {
  "type": "string",
  "enum": ["direct", "pr"],
  "description": "Merge strategy. direct=worktree merge, pr=pull request. Overrides coordinator config."
}
```

**File:** `types/backlog.ts`

Add to Task type: `merge_strategy?: 'direct' | 'pr';`

### Step 3 — Add PR states and fields to claims schema and type

**File:** `schemas/claims.schema.json`

Extend FinalizationState enum (line 32):

```json
"enum": ["awaiting_finalize", "finalize_rebase_requested", "finalize_rebase_in_progress",
         "ready_to_merge", "blocked_finalize",
         "pr_created", "pr_review_in_progress", "pr_merged", "pr_failed"]
```

Add to Claim properties:

```json
"pr_ref": { "type": ["string", "null"], "description": "PR URL or reference." },
"pr_created_at": { "type": ["string", "null"], "format": "date-time" },
"pr_reviewer_agent_id": { "type": ["string", "null"], "description": "Agent ID of the PR reviewer worker." }
```

**File:** `types/claims.ts`

Add to Claim: `pr_ref?: string | null`, `pr_created_at?: string | null`, `pr_reviewer_agent_id?: string | null`.

### Step 4 — Parse merge_strategy in backlog sync

**Files:** `lib/backlogSync.ts`, `lib/taskSpecReader.ts`

Follow the exact `review_level` pattern: add `merge_strategy` to `SpecFrontmatter`, `parseSpecFrontmatter`, `SpecEntry`, and `syncBacklogFromSpecsLoaded`.

### Step 5 — Document config fields

**File:** `docs/configuration.md`

Add to coordinator config table:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `merge_strategy` | string | `"direct"` | `"direct"` for worktree merge, `"pr"` for pull request. |
| `pr_provider` | string\|null | `null` | Git host provider (`"github"`). Required when `merge_strategy` is `"pr"`. |
| `pr_push_remote` | string | `"origin"` | Git remote to push PR branches to. |
| `pr_finalize_lease_ms` | integer | `86400000` | Claim lease duration for PR finalization (24h). |

### Step 6 — Update task template

**File:** `backlog/TASK_TEMPLATE.md`

Add to frontmatter (commented out): `# merge_strategy: direct`

---

## Acceptance criteria

- [ ] `CoordinatorConfig` includes all 4 new fields with correct types and defaults.
- [ ] `loadCoordinatorConfig()` parses all fields from config file.
- [ ] `schemas/backlog.schema.json` Task has optional `merge_strategy` enum.
- [ ] `types/backlog.ts` Task type has `merge_strategy?`.
- [ ] FinalizationState enum includes all 4 new PR states (`pr_created`, `pr_review_in_progress`, `pr_merged`, `pr_failed`).
- [ ] Claim schema and type include `pr_ref`, `pr_created_at`, `pr_reviewer_agent_id`.
- [ ] Backlog sync propagates `merge_strategy` from frontmatter to `backlog.json`.
- [ ] Existing tasks without `merge_strategy` continue to work (backward compatible).
- [ ] `orc doctor` exits 0 after schema changes.
- [ ] `docs/configuration.md` documents all new fields.
- [ ] `npm test` passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/providers.test.ts`:

```typescript
it('parses merge_strategy from config', () => { ... });
it('defaults merge_strategy to direct', () => { ... });
it('parses pr_provider, pr_push_remote, pr_finalize_lease_ms', () => { ... });
```

Add to backlog sync tests:

```typescript
it('syncs merge_strategy from task spec frontmatter', () => { ... });
it('defaults merge_strategy to undefined when absent', () => { ... });
```

Add to schema validation tests:

```typescript
it('accepts pr finalization states', () => { ... });
it('accepts pr_ref, pr_created_at, pr_reviewer_agent_id on claims', () => { ... });
```

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
orc doctor
```

---

## Risk / Rollback

**Risk:** Schema changes could invalidate existing state if fields are required. All new fields are optional — existing state remains valid.
**Rollback:** `git restore lib/providers.ts schemas/ types/ lib/backlogSync.ts lib/taskSpecReader.ts docs/configuration.md backlog/TASK_TEMPLATE.md && npm test`
