---
ref: orch/task-160-backlog-folder-restructure-and-epic-to-feature-rename
epic: orch
status: todo
---

# Task 160 — Backlog folder restructure and epic-to-feature rename

Independent.

## Scope

**In scope:**
- Move existing `docs/backlog/*.md` spec files (numbers 1-159) into a new `docs/backlog/legacy/` subfolder and update their frontmatter (`epic:` → `feature:`).
- Introduce a new folder convention: `docs/backlog/FEAT-XXX-slug/NNN.md` for all future tasks; tasks in this task's own feature group live under `docs/backlog/FEAT-001-orch/`.
- Rename the `epics` array to `features` in `backlog.schema.json`, `backlog.json` (live state), and every code site that reads or writes that key.
- Rename the `Epic` definition to `Feature` in the schema.
- Replace `--epic` / `--epic-title` flags with `--feature` / `--feature-title` in `task-create.mjs` and `init.mjs`.
- Replace `epic:` frontmatter key with `feature:` in `backlogSync.mjs`, `backlog_sync_check.mjs`, and `TASK_TEMPLATE.md`.
- Switch `backlogSync.mjs` and `backlog_sync_check.mjs` from flat `readdirSync` to recursive scan using `{ recursive: true }`.
- Update `SPEC_FILE_RE` to match files by basename only (still `^\d+(-[^.]+)?\.md$`) so `feat.md` is excluded.
- Add `next_task_seq` guard: `Math.max(backlog.next_task_seq ?? 0, 160)` inside the lock in `task-create.mjs`.
- Update all `epic` references in: `stateReader.mjs`, `taskScheduler.mjs`, `statusView.mjs`, `stateValidation.mjs`, `handlers.mjs`, `tools-list.mjs`, `master-bootstrap-v1.txt`, `AGENTS.md`, and all test files that reference `epics` or `--epic`.
- Update `TASK_TEMPLATE.md` frontmatter to use `feature:` and new file path comment.
- Add a `README.md` to `docs/backlog/` explaining the folder structure.
- Update all affected tests to match renamed flags and JSON keys.

**Out of scope:**
- Changing the `TaskRef` pattern in the schema — `^[a-z0-9-]+/[a-z0-9-]+$` stays unchanged.
- Changing any task `ref` values already stored in `backlog.json`.
- Changing any claim, agent, or event schema files.
- Modifying game source files under `src/`.
- Adding new npm dependencies.
- Changing the `orc` CLI entry point or any unrelated orchestrator commands.

---

## Context

The orchestrator currently organises backlog tasks under a flat `docs/backlog/` directory and uses the term "epic" for the grouping container. Two usability problems exist:

1. **Flat file growth** — with 159 specs already present the flat directory is unwieldy. A subfolder layout (`FEAT-XXX-slug/`) groups related specs and scales cleanly.
2. **Terminology mismatch** — "epic" connotes a large Jira-style chunk of work that spans many teams and quarters. The actual grouping container is a lightweight feature bucket; "feature" is the correct term and aligns with the `feat.md` context file the new convention introduces.

Renaming "epic" to "feature" affects: the JSON schema definition, the live `backlog.json` state key, five library modules, two CLI entry points, the MCP handler layer, three template/doc files, and every test that seeds or asserts on the old key name.

### Current state

- `docs/backlog/` is a flat folder containing 159 numbered `.md` files with `epic:` in frontmatter.
- `backlog.schema.json` has a top-level `"epics"` array and an `"Epic"` definition.
- `backlogSync.mjs` calls `readdirSync(docsDir)` (non-recursive) and filters by `SPEC_FILE_RE = /^\d+-.+\.md$/`.
- `task-create.mjs` requires `--epic=<ref>` and reads `backlog.epics` to locate the target container.
- `scripts/backlog_sync_check.mjs` also does a flat `readdirSync`.

### Desired state

- `docs/backlog/legacy/` holds the 159 existing specs with `feature:` frontmatter.
- New task specs live under `docs/backlog/FEAT-XXX-slug/NNN.md`.
- All code references `features` (not `epics`) and all CLI flags use `--feature` (not `--epic`).
- `backlogSync` and `backlog_sync_check` recurse into subfolders.
- `orc doctor` exits 0 after the migration.

### Start here

- `/Users/teemu/code/orc-state/schemas/backlog.schema.json` — defines `epics` array and `Epic` definition.
- `/Users/teemu/code/orc-state/lib/backlogSync.mjs` — flat scan + `epic:` parsing; needs recursive scan + `feature:`.
- `/Users/teemu/code/orc-state/cli/task-create.mjs` — `--epic` flag and `backlog.epics` lookup.

**Affected files:**
- `/Users/teemu/code/orc-state/schemas/backlog.schema.json` — schema definition
- `/Users/teemu/code/orc-state/lib/backlogSync.mjs` — spec scan + sync logic
- `/Users/teemu/code/orc-state/scripts/backlog_sync_check.mjs` — sync check script
- `/Users/teemu/code/orc-state/lib/stateReader.mjs` — `findTask` + `getNextTaskSeq` iterate `epics`
- `/Users/teemu/code/orc-state/lib/taskScheduler.mjs` — iterates `backlog.epics`
- `/Users/teemu/code/orc-state/lib/statusView.mjs` — `buildTaskCounts`, `listDispatchReadyTasks`, `buildAgentStatus` iterate `epics`; emits `epic_ref`
- `/Users/teemu/code/orc-state/lib/stateValidation.mjs` — `validateStateInvariants` iterates `epics`
- `/Users/teemu/code/orc-state/cli/task-create.mjs` — `--epic` flag, `backlog.epics` lookup
- `/Users/teemu/code/orc-state/cli/init.mjs` — `--epic` / `--epic-title` flags, writes `epics` key
- `/Users/teemu/code/orc-state/mcp/handlers.mjs` — `epic_ref`, `backlog.epics`, `handleListTasks` `epic` param
- `/Users/teemu/code/orc-state/mcp/tools-list.mjs` — `list_tasks` `epic` property description
- `/Users/teemu/code/orc-state/templates/master-bootstrap-v1.txt` — references `epic_ref`
- `/Users/teemu/code/orc-state/docs/backlog/TASK_TEMPLATE.md` — `epic:` frontmatter line
- `/Users/teemu/code/orc-state/AGENTS.md` — all `epic` references
- `/Users/teemu/code/orc-state/.orc-state/backlog.json` — live state: `"epics"` key → `"features"`
- `docs/backlog/legacy/*.md` — frontmatter `epic:` → `feature:`
- Test files: `cli/task-create.test.mjs`, `cli/init.test.mjs`, `mcp/handlers.test.mjs`, `lib/taskScheduler.test.mjs`, `lib/statusView.test.mjs`, `lib/backlogSync.test.mjs`, `lib/stateValidation.test.mjs`, `e2e/*.e2e.test.mjs`

---

## Goals

1. Must rename the `epics` JSON key to `features` in `backlog.schema.json` and the `Epic` definition to `Feature`; `orc doctor` must exit 0 after the schema change.
2. Must migrate `.orc-state/backlog.json` by renaming the `"epics"` key to `"features"` without altering any task refs, statuses, or other fields.
3. Must move all 159 existing spec files into `docs/backlog/legacy/` and replace `epic:` with `feature:` in each file's YAML frontmatter.
4. Must replace every `--epic` CLI flag with `--feature` (and `--epic-title` with `--feature-title`) in `task-create.mjs` and `init.mjs`, and update all corresponding tests.
5. Must upgrade `backlogSync.mjs` and `backlog_sync_check.mjs` to recurse into subdirectories and filter by `basename` so `feat.md` files are excluded.
6. Must update all library and MCP code that reads `backlog.epics` or emits `epic_ref` to use `backlog.features` / `feature_ref` instead.
7. Must add the `next_task_seq` floor guard (`Math.max(backlog.next_task_seq ?? 0, 160)`) inside the lock in `task-create.mjs` so that auto-assigned IDs start at 160 even when the stored counter is stale.

---

## Implementation

### Step 1 — Update backlog JSON schema

**File:** `/Users/teemu/code/orc-state/schemas/backlog.schema.json`

- In `required`: replace `"epics"` with `"features"`.
- In `properties`: rename the `epics` property key to `features`; update its `$ref` to `#/definitions/Feature`.
- In `definitions`: rename `Epic` to `Feature`; update the `ref` property description from "Epic slug" to "Feature slug".

```json
// required array
"required": ["version", "features"],
// properties
"features": {
  "type": "array",
  "items": { "$ref": "#/definitions/Feature" }
},
// definitions key renamed
"Feature": { ... }
```

Invariant: `TaskRef` pattern, `Task` definition, and all other definitions remain unchanged.

### Step 2 — Migrate live backlog.json state

**File:** `/Users/teemu/code/orc-state/.orc-state/backlog.json`

Run this one-time migration inside a script (or manually with `withLock`):

```js
// Read, rename key, write atomically
const b = JSON.parse(readFileSync(backlogPath, 'utf8'));
b.features = b.epics;
delete b.epics;
atomicWriteJson(backlogPath, b);
```

Run `npm run orc:doctor` immediately after to confirm the renamed state validates against the updated schema.

### Step 3 — Move existing spec files into legacy/ and update frontmatter

```bash
mkdir -p docs/backlog/legacy
# Move all numbered specs
for f in docs/backlog/[0-9]*.md; do
  mv "$f" docs/backlog/legacy/
done
# Rename epic: to feature: in frontmatter of every moved file
for f in docs/backlog/legacy/*.md; do
  sed -i '' 's/^epic: /feature: /' "$f"
done
```

Invariant: the `ref:` lines in frontmatter are not modified.

### Step 4 — Update backlogSync.mjs

**File:** `/Users/teemu/code/orc-state/lib/backlogSync.mjs`

Replace `SPEC_FILE_RE`, `readSpecs`, `parseSpecFrontmatter`, `findTaskEntry`, `ensureEpic`, and the `syncBacklogFromSpecs` body:

```js
const SPEC_FILE_RE = /^\d+(-[^.]+)?\.md$/;

function parseSpecFrontmatter(text) {
  const block = text.match(/^---\s*\n([\s\S]*?)\n---(?:\n|$)/)?.[1] ?? '';
  return {
    ref: block.match(/^ref:\s+(.+)$/m)?.[1]?.trim() ?? null,
    feature: block.match(/^feature:\s+(.+)$/m)?.[1]?.trim() ?? null,
    status: block.match(/^status:\s+(.+)$/m)?.[1]?.trim() ?? null,
  };
}

function readSpecs(docsDir) {
  return readdirSync(docsDir, { recursive: true })
    .filter((rel) => SPEC_FILE_RE.test(basename(rel)))
    .sort((a, b) => basename(a).localeCompare(basename(b), 'en', { numeric: true }))
    .flatMap((rel) => {
      const text = readFileSync(join(docsDir, rel), 'utf8');
      const { ref, feature, status } = parseSpecFrontmatter(text);
      if (!ref || !feature || !status || !VALID_SPEC_STATUSES.has(status)) return [];
      return [{ ref, feature, status, title: parseSpecTitle(text, ref) }];
    });
}
```

Replace all `epic` variable names and `backlog.epics` references with `feature` / `backlog.features`. Rename `ensureEpic` → `ensureFeature`; rename the `addedEpics` counter → `addedFeatures`; update the returned object key from `added_epics` → `added_features`.

Add `import { basename } from 'node:path';` to the existing path import line.

Invariant: `withLock` + `atomicWriteJson` call sites are unchanged.

### Step 5 — Update scripts/backlog_sync_check.mjs

**File:** `/Users/teemu/code/orc-state/scripts/backlog_sync_check.mjs`

Switch `extractTaskSpecRefs` to recursive scan:

```js
export function extractTaskSpecRefs(backlogDocsDir) {
  return readdirSync(backlogDocsDir, { recursive: true })
    .filter((rel) => /^\d+(-[^.]+)?\.md$/.test(basename(rel)))
    .sort((a, b) => basename(a).localeCompare(basename(b), 'en', { numeric: true }))
    .flatMap((rel) => {
      const text = readFileSync(join(backlogDocsDir, rel), 'utf8');
      const refMatch = text.match(/^ref:\s+(.+)$/m);
      if (!refMatch) return [];
      return [{ file: rel, ref: refMatch[1].trim() }];
    });
}
```

Replace `backlog.epics` with `backlog.features` in `extractRegisteredTaskRefs`.

Add `import { basename } from 'node:path';` if not already present.

### Step 6 — Update task-create.mjs

**File:** `/Users/teemu/code/orc-state/cli/task-create.mjs`

- Rename flag read: `flag('epic')` → `flag('feature')`.
- Rename `epicRef` → `featureRef`.
- Replace `backlog.epics` with `backlog.features`.
- Add `next_task_seq` floor guard inside the lock, before slug resolution:

```js
const featureRef = flag('feature');
// ...
const refOverride = flag('ref');
const nextId = Math.max(backlog.next_task_seq ?? 0, 160);
const taskSlug = refOverride ?? String(nextId);
const taskRef = `${featureRef}/${taskSlug}`;
if (!refOverride) backlog.next_task_seq = nextId + 1;
```

- Update error messages: `"Epic not found"` → `"Feature not found"`.
- Update event payload: `epic_ref: epicRef` → `feature_ref: featureRef`.
- Update usage string in the error path.

Invariant: `withLock` + `atomicWriteJson` + `appendSequencedEvent` call pattern is unchanged.

### Step 7 — Update init.mjs

**File:** `/Users/teemu/code/orc-state/cli/init.mjs`

- `flag('epic')` → `flag('feature')`; default `'project'` unchanged.
- `flag('epic-title')` → `flag('feature-title')`; default `'Project'` unchanged.
- `backlog.epics` → `backlog.features` in the initial state object.
- Update usage comment in file header.

### Step 8 — Update library modules

**Files (mechanical `epics` → `features` rename):**

- `/Users/teemu/code/orc-state/lib/stateReader.mjs` — `findTask` and `getNextTaskSeq` both iterate `backlog?.epics` → `backlog?.features`.
- `/Users/teemu/code/orc-state/lib/taskScheduler.mjs` — `nextEligibleTaskFromBacklog` iterates `backlog?.epics` twice → `backlog?.features`.
- `/Users/teemu/code/orc-state/lib/statusView.mjs` — `buildTaskCounts`, `listDispatchReadyTasks`, `buildAgentStatus` all iterate `backlogFile.epics` → `backlogFile.features`; the `epic_ref` field emitted in `listDispatchReadyTasks` and `buildAgentStatus` → `feature_ref`.
- `/Users/teemu/code/orc-state/lib/stateValidation.mjs` — `validateStateInvariants` iterates `backlog?.epics` → `backlog?.features`.

### Step 9 — Update MCP layer

**File:** `/Users/teemu/code/orc-state/mcp/handlers.mjs`

- `handleListTasks`: parameter `epic` → `feature`; guard message; `backlog.epics` → `backlog.features`; filter line `task.epic_ref === epic` → `task.feature_ref === feature`; the spread `epic_ref: epicObj.ref` → `feature_ref: featureObj.ref`.
- `LIST_TASK_FIELDS` set: replace `'epic_ref'` with `'feature_ref'`.
- `handleCreateTask` (if present): all `epic`/`epics` references.
- `toTaskSummary` and other helpers: `epic_ref` → `feature_ref`.

**File:** `/Users/teemu/code/orc-state/mcp/tools-list.mjs`

- `list_tasks` tool: rename `epic` property to `feature`; update description string.

### Step 10 — Update templates and docs

**File:** `/Users/teemu/code/orc-state/templates/master-bootstrap-v1.txt`

- Replace `epic_ref` with `feature_ref` wherever it appears.

**File:** `/Users/teemu/code/orc-state/docs/backlog/TASK_TEMPLATE.md`

- Change frontmatter line `epic: <epic-ref>` → `feature: <feature-ref>`.
- Update file path comment in header (if present) to reflect new subfolder convention.

**File:** `/Users/teemu/code/orc-state/AGENTS.md`

- Replace all `epic` / `epics` / `epic_ref` references with `feature` / `features` / `feature_ref`.
- Update the state-files table to show `features` array.
- Update any `orc task-create` examples that use `--epic`.

**New file:** `/Users/teemu/code/orc-state/docs/backlog/README.md`

Document the folder convention:
```
docs/backlog/
  legacy/             existing specs 1-159, feature: orch
  FEAT-001-slug/
    feat.md           optional agent context (no ref: field, excluded by SPEC_FILE_RE)
    NNN.md            task spec(s) for this feature
  TASK_TEMPLATE.md
  README.md
```

### Step 11 — Update all test files

Mechanical rename pass — replace `epics` → `features`, `--epic` → `--feature`, `epic_ref` → `feature_ref`, and `added_epics` → `added_features` in fixture objects and assertions:

- `/Users/teemu/code/orc-state/cli/task-create.test.mjs`
- `/Users/teemu/code/orc-state/cli/init.test.mjs`
- `/Users/teemu/code/orc-state/mcp/handlers.test.mjs`
- `/Users/teemu/code/orc-state/lib/taskScheduler.test.mjs`
- `/Users/teemu/code/orc-state/lib/statusView.test.mjs`
- `/Users/teemu/code/orc-state/lib/backlogSync.test.mjs`
- `/Users/teemu/code/orc-state/lib/stateValidation.test.mjs`
- `/Users/teemu/code/orc-state/e2e/worker-control-flow.e2e.test.mjs`
- `/Users/teemu/code/orc-state/e2e/coordinatorPolicies.e2e.test.mjs`
- `/Users/teemu/code/orc-state/e2e/orchestrationLifecycle.e2e.test.mjs`

In `backlogSync.test.mjs`, add four new test cases for recursive spec discovery:
1. Spec in a `legacy/` subfolder is found by `readSpecs`.
2. Spec in a `FEAT-001-orch/` subfolder is found.
3. A `feat.md` file in a subfolder is NOT matched (excluded by `SPEC_FILE_RE` basename filter).
4. Specs from multiple subdirectory depths sort correctly by numeric basename.

In `task-create.test.mjs`, add two new test cases:
1. Auto-assigned ID starts at 160 when `next_task_seq` is absent.
2. Auto-assigned ID uses `Math.max(next_task_seq, 160)` when stored value is less than 160.

---

## Acceptance criteria

- [ ] `npm run orc:doctor` exits 0 after schema + state migration (Step 1 + 2).
- [ ] `npm run backlog:sync:check` exits 0 with all 159 legacy specs plus this spec (160) found.
- [ ] `node cli/orc.mjs task-create --feature=orch --title="Test auto-ID"` exits 0 and creates ref `orch/160` (or the next available sequential ID).
- [ ] `node cli/orc.mjs init --feature=myproject --feature-title="My Project"` exits 0 and writes `features` (not `epics`) in the generated `backlog.json`.
- [ ] `node cli/orc.mjs task-create --epic=orch --title="Old flag"` exits 1 with a descriptive error (old flag no longer accepted).
- [ ] `backlogSync.mjs` `readSpecs` picks up a spec placed at `docs/backlog/FEAT-001-orch/160.md`.
- [ ] `backlogSync.mjs` does NOT pick up a file named `feat.md` in any subdirectory.
- [ ] `orc status` output shows task counts correctly after the `epics` → `features` rename in state.
- [ ] All existing spec files in `docs/backlog/legacy/` have `feature:` (not `epic:`) in frontmatter.
- [ ] `npm test` passes with zero failures.
- [ ] `npm run build` exits 0 with zero TypeScript errors.
- [ ] No files outside the stated scope are modified.

---

## Tests

Add to `/Users/teemu/code/orc-state/lib/backlogSync.test.mjs`:

```js
it('readSpecs finds spec in legacy/ subfolder', () => {
  // place a spec at <tmpDir>/legacy/5-foo.md with feature: orch frontmatter
  // assert syncBacklogFromSpecs picks it up
});

it('readSpecs finds spec in FEAT-001-orch/ subfolder', () => {
  // place a spec at <tmpDir>/FEAT-001-orch/160.md
  // assert syncBacklogFromSpecs picks it up
});

it('readSpecs ignores feat.md files in subfolders', () => {
  // place <tmpDir>/FEAT-001-orch/feat.md — no leading digit
  // assert it is NOT returned by readSpecs
});

it('readSpecs sorts specs from multiple subdirectories by numeric basename', () => {
  // place 3.md in legacy/ and 10.md in FEAT-001-orch/
  // assert returned order is [3.md, 10.md]
});
```

Add to `/Users/teemu/code/orc-state/cli/task-create.test.mjs`:

```js
it('auto-assigns ID starting at 160 when next_task_seq is absent', () => {
  // seed backlog without next_task_seq; run without --ref
  // assert created ref is 'docs/160'
});

it('auto-assigned ID uses Math.max(next_task_seq, 160) when stored value < 160', () => {
  // seed backlog with next_task_seq: 57; run without --ref
  // assert created ref is 'docs/160'
});
```

Existing tests in `task-create.test.mjs`, `init.test.mjs`, `handlers.test.mjs`, `taskScheduler.test.mjs`, `statusView.test.mjs`, `stateValidation.test.mjs`, and `e2e/*.e2e.test.mjs` must be updated to use `features` / `--feature` / `feature_ref` in all fixture JSON and CLI invocations.

---

## Verification

```bash
# Targeted: schema validation
nvm use 24 && node -e "
const {validateBacklog} = require('./lib/stateValidation.mjs');
"
```

```bash
# Targeted: backlogSync recursive scan
nvm use 24 && npx vitest run lib/backlogSync.test.mjs
```

```bash
# Targeted: task-create auto-ID
nvm use 24 && npx vitest run cli/task-create.test.mjs
```

```bash
# Targeted: init flag rename
nvm use 24 && npx vitest run cli/init.test.mjs
```

```bash
# Final required repo-wide checks before marking the task done
nvm use 24 && npm run build
nvm use 24 && npm test
```

```bash
# Smoke checks — schema and state files changed
npm run orc:doctor
npm run orc:status
npm run backlog:sync:check
# Expected: all three exit 0, no validation errors
```

---

## Risk / Rollback

**Risk:** The `backlog.json` state mutation (Step 2) is the highest-risk operation. If the write is interrupted after the schema update but before the data migration, `orc doctor` will report a validation error on the `"epics"` key because the schema now requires `"features"`. Any in-flight task dispatching or coordinator ticks during the migration window could read a momentarily inconsistent file.

**Rollback:**
1. Revert `backlog.schema.json` from git (`git checkout HEAD -- schemas/backlog.schema.json`).
2. Restore `.orc-state/backlog.json` from the `.bak` copy created by `init.mjs --force`, or from the last git-tracked snapshot.
3. Run `npm run orc:doctor` to confirm the reverted state is valid.
4. Move spec files back from `docs/backlog/legacy/` to `docs/backlog/` and revert their frontmatter (`feature:` → `epic:`) using `sed`.

**Partial-write guard:** Perform the `backlog.json` state migration using `withLock` + `atomicWriteJson` (never `writeFileSync`) to avoid leaving a corrupt file on disk if the process is interrupted.
