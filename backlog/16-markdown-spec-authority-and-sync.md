---
ref: general/16-markdown-spec-authority-and-sync
feature: general
priority: high
status: todo
---

# Task 16 — Make Markdown Specs the Authority for Backlog Metadata

Depends on Task 15. Blocks Task 17.

## Scope

**In scope:**
- Define the authority boundary between `backlog/*.md` specs and `.orc-state/backlog.json`
- Update sync tooling so active specs are sourced from `backlog/` while `backlog/legacy/` is ignored
- Use one shared active-spec discovery model across validation, repair, and markdown task reading
- Extend sync checking from missing-ref detection to metadata consistency checks for authoritative fields
- Add or expose a repair path that can reconcile runtime backlog metadata from markdown specs

**Out of scope:**
- Event log sequencing or coordinator lifecycle handling
- Workflow simplification beyond the spec/state synchronization surface
- Reducer extraction or lifecycle hardening tests unrelated to spec authority

---

## Context

The repository wants a spec-first planning workflow, but the current sync tooling is weaker than that intent. It still treats legacy specs as active input in some places and only verifies that task refs exist, which allows metadata drift between markdown specs and orchestrator state.

### Current state

`backlog/*.md` acts like the human-facing source of truth, but `.orc-state/backlog.json` can drift in title, status, or placement without a clear repair workflow. Existing sync checks catch missing refs only, legacy task files still bleed into validation in parts of the toolchain, and the checker, repair path, and markdown task reader do not yet share one discovery model.

### Desired state

Markdown specs under `backlog/` should be the authoritative source for task metadata, `backlog/legacy/` should be ignored by active sync tooling, and operators should have a clear check/repair path to realign runtime metadata with the specs. Validation, repair, and markdown task reads must all use the same recursive active-spec discovery rules so they cannot disagree about which tasks are live.

### Start here

- `cli/backlog-sync-check.ts` — current ref-only validation logic
- `lib/backlogSync.ts` — current repair/sync behavior
- `lib/taskSpecReader.ts` — current markdown task lookup behavior
- `lib/paths.ts` — current backlog docs path resolution

**Affected files:**
- `cli/backlog-sync-check.ts` — metadata-aware sync validation
- `lib/backlogSync.ts` — authority rules, shared active-spec discovery, and repair behavior
- `lib/taskSpecReader.ts` — active-spec lookup aligned with the shared discovery model
- `cli/orc.ts` or a dedicated CLI file — expose a repair command if one does not already exist
- `backlog/README.md` and `README.md` — document the new authority boundary and commands

---

## Goals

1. Must treat active markdown specs in `backlog/` as the authority for task metadata.
2. Must ignore `backlog/legacy/` in active sync and validation workflows.
3. Must use one shared active-spec discovery model for validation, repair, and markdown task reads.
4. Must detect metadata drift, not just missing task refs.
5. Must provide a supported repair path to resync orchestrator state from markdown specs.
6. Must leave runtime-only execution fields under orchestrator ownership.

---

## Implementation

### Step 1 — Define the authority boundary

**File:** `lib/backlogSync.ts`

Document and encode which task fields are owned by markdown specs and which remain runtime-only so sync logic can update the right surfaces without trampling live execution state.

### Step 2 — Unify active-spec discovery

**File:** `lib/backlogSync.ts`

Extract or introduce shared recursive spec discovery that treats `backlog/legacy/` as excluded input for validation and repair.

### Step 3 — Align markdown task lookup

**File:** `lib/taskSpecReader.ts`

Update markdown task lookup to use the same active-spec discovery rules so task reads and sync behavior agree on which specs are live.

### Step 4 — Exclude legacy specs from active sync

**File:** `cli/backlog-sync-check.ts`

Point validation at the shared active-spec discovery rules so `backlog/legacy/` does not participate in active validation.

### Step 5 — Upgrade sync validation

**File:** `cli/backlog-sync-check.ts`

Expand validation beyond presence checks to compare authoritative metadata such as `ref`, `feature`, `title`, and spec-driven status where applicable.

### Step 6 — Expose repair and document the flow

**File:** `cli/orc.ts`

Expose a stable repair path if needed, then document the authority model and the recommended check/repair workflow in the backlog docs and top-level README.

---

## Acceptance criteria

- [ ] `backlog-sync-check` ignores `backlog/legacy/`.
- [ ] Validation, repair, and markdown task reads use the same active-spec discovery rules.
- [ ] Sync validation reports metadata mismatches for authoritative fields instead of only missing refs.
- [ ] There is a supported repair path that updates `.orc-state/backlog.json` from the active markdown specs.
- [ ] Runtime-only execution fields are not overwritten during sync repair.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `cli/backlog-sync-check.test.ts`, `lib/backlogSync.test.ts`, and `lib/taskSpecReader.test.ts`:

```ts
it('ignores backlog/legacy during active sync validation', () => { ... });
it('uses the same active-spec discovery rules for validation, repair, and markdown task reads', () => { ... });
it('reports metadata drift for authoritative task fields', () => { ... });
it('repairs orchestrator backlog metadata from markdown specs without clobbering runtime-only fields', () => { ... });
```

---

## Verification

```bash
# Targeted verification for this task only
npx vitest run cli/backlog-sync-check.test.ts lib/backlogSync.test.ts
```

```bash
# Final required repo-wide checks before marking the task done
nvm use 24 && npm test
```

```bash
# Smoke checks — include only when schema, state, or CLI changes are in scope
orc doctor
orc status
orc backlog-sync-check
# Expected: exits 0, no validation errors
```

---

## Risk / Rollback

**Risk:** Incorrect authority rules could overwrite live task state or make valid specs appear out of sync.
**Rollback:** Revert the sync/repair changes, restore `.orc-state/backlog.json` from git if needed, and re-run `orc doctor` plus `orc backlog-sync-check`.
