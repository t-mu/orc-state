---
ref: orch/task-153-add-status-field-to-spec-files
epic: orch
status: done
---

# Task 153 — Add Status Field to All Spec Files

Independent. Blocks Tasks 154, 155, and 156.

## Scope

**In scope:**
- Add `status: todo` or `status: done` to the YAML frontmatter of all 49 spec files in `docs/backlog/` that already have a `ref:` field.
- Tasks 102–140 (already implemented) receive `status: done`.
- Tasks 141–152 (pending) receive `status: todo`.
- Task 153 itself (this file) receives `status: todo`.
- Update `docs/backlog/TASK_TEMPLATE.md` to include `status: todo` as a required frontmatter field immediately below `epic:`.

**Out of scope:**
- Spec files without a `ref:` field (tasks 02–18 and any unnumbered files) — do not touch.
- Orchestrator source code — no `.mjs` changes.
- `scripts/backlog_sync_check.mjs` — extended in Task 156, not here.
- `.orc-state/backlog.json` — no state file changes.

---

## Context

### Current state

All 49 numbered spec files with a `ref:` field carry only `ref:` and `epic:` in their YAML frontmatter. There is no machine-readable `status:` field. When `.orc-state/` is wiped, there is no way to reconstruct which tasks are done versus pending from the markdown files alone — all status knowledge is lost.

### Desired state

Every spec file that has a `ref:` field also has a `status:` field. The coordinator (Task 155) can scan these files at startup and reconstruct the full backlog state without any manual intervention. The `status:` value on `main` is always correct because workers update it as part of their merge commit (Task 154).

### Start here

- `docs/backlog/102-task-md-frontmatter.md` — example of a done task to update
- `docs/backlog/141-add-managed-worker-pool-config-and-slot-model.md` — example of a todo task to update
- `docs/backlog/TASK_TEMPLATE.md` — template to update

**Affected files:**
- `docs/backlog/102-*.md` through `docs/backlog/140-*.md` — 37 spec files, each gets `status: done`
- `docs/backlog/141-*.md` through `docs/backlog/153-*.md` — 13 spec files (141–152 + this file), each gets `status: todo`
- `docs/backlog/TASK_TEMPLATE.md` — add `status: todo` to frontmatter example

---

## Goals

1. Must add `status: done` to frontmatter of all spec files for tasks 102–140 (37 files).
2. Must add `status: todo` to frontmatter of all spec files for tasks 141–153 (13 files, including this one).
3. Must not add `status:` to spec files that lack a `ref:` field.
4. Must update `TASK_TEMPLATE.md` so the frontmatter block includes `status: todo` below `epic:`.
5. Must leave all other frontmatter fields and markdown body content unchanged.

---

## Implementation

### Step 1 — Update TASK_TEMPLATE.md frontmatter

**File:** `docs/backlog/TASK_TEMPLATE.md`

Change the frontmatter from:
```yaml
---
ref: <epic>/<slug>
epic: <epic-ref>
---
```
to:
```yaml
---
ref: <epic>/<slug>
epic: <epic-ref>
status: todo
---
```

### Step 2 — Add `status: done` to tasks 102–140

For each of the 37 files `docs/backlog/102-*.md` through `docs/backlog/140-*.md` that have a `ref:` field, insert `status: done` after the `epic:` line in the YAML frontmatter:

```yaml
---
ref: orch/task-102-task-md-frontmatter
epic: orch
status: done
---
```

Use a script or targeted edits. A sed one-liner can batch this:

```bash
# For done tasks (102-140): insert status: done after epic: line
for f in docs/backlog/10[2-9]-*.md docs/backlog/1[1-3][0-9]-*.md docs/backlog/140-*.md; do
  grep -q "^ref:" "$f" && sed -i '' '/^epic:/a\\nstatus: done' "$f"
done
```

Verify each file: the frontmatter block should end with `status: done` before the closing `---`.

### Step 3 — Add `status: todo` to tasks 141–153

For each of the 13 files `docs/backlog/141-*.md` through `docs/backlog/153-*.md`, insert `status: todo` after the `epic:` line:

```yaml
---
ref: orch/task-141-add-managed-worker-pool-config-and-slot-model
epic: orch
status: todo
---
```

### Step 4 — Verify no spec file with a `ref:` is missing `status:`

```bash
# All 49 ref-bearing specs should now have a status: line
grep -l "^ref:" docs/backlog/[0-9]*.md | while read f; do
  grep -q "^status:" "$f" || echo "MISSING: $f"
done
# Expected: no output
```

---

## Acceptance criteria

- [ ] Every spec file with a `ref:` field also has a `status:` field in its YAML frontmatter.
- [ ] Files with `ref:` for tasks 102–140 have `status: done`.
- [ ] Files with `ref:` for tasks 141–153 have `status: todo`.
- [ ] Spec files without a `ref:` field (tasks 02–18 and others) are unchanged.
- [ ] `docs/backlog/TASK_TEMPLATE.md` frontmatter includes `status: todo`.
- [ ] `npm run backlog:sync:check` still exits 0 after these changes.
- [ ] No changes to files outside `docs/backlog/`.

---

## Tests

No automated tests — this task only edits markdown files. Acceptance is verified by the shell command in Step 4 above.

---

## Verification

```bash
# Confirm all ref-bearing specs now have status:
grep -l "^ref:" docs/backlog/[0-9]*.md | while read f; do
  grep -q "^status:" "$f" || echo "MISSING: $f"
done
# Expected: no output
```

```bash
nvm use 24 && npm run backlog:sync:check
```

```bash
nvm use 24 && npm run build
nvm use 24 && npm test
```
