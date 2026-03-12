---
ref: orch/task-126-generate-backlog-task-index
epic: orch
status: done
---

# Task 126 — Generate Backlog Task Index

Depends on Task 125. Blocks Task 127 and Task 129 because later prompt-workflow tasks should preserve this index-first lookup behavior.

## Scope

**In scope:**
- `scripts/backlog-index.mjs` — generate a compact JSON index for `docs/backlog/*.md`
- `docs/backlog/index.json` — generated machine-readable task summary artifact
- `.codex/skills/create-task/SKILL.md` — use the generated index as the first-pass lookup for overlapping tasks
- `.claude/skills/create-task/SKILL.md` — same first-pass index usage
- `docs/backlog/README.md` — document how to regenerate and use the index

**Out of scope:**
- Editing historical task prose bodies just to normalize content
- Replacing `docs/backlog/*.md` as the authoritative task specification source
- Changing orchestrator runtime state in `orc-state/backlog.json`

---

## Context

Task creation currently requires scanning markdown files directly to find the next relevant examples, detect duplicates, and understand dependency patterns. Even with frontmatter, repeatedly opening many task files is more expensive than reading one compact machine-readable index.

The backlog directory already acts as the authoritative spec source, so the right optimization is a generated read model, not a second authoring format. A small script can scan the markdown files, extract the fields that matter most for overlap detection, and write them to `docs/backlog/index.json`. The task-creation skills can then consult that file first and only open full markdown files when a task looks relevant.

The index must tolerate mixed historical formats: newer tasks include frontmatter, older ones may not. The generator should derive what it can deterministically from the filename, heading line, and any frontmatter present rather than requiring a full backlog migration in the same task.

**Affected files:**
- `scripts/backlog-index.mjs` — index generator
- `docs/backlog/index.json` — generated task catalog
- `.codex/skills/create-task/SKILL.md` — first-pass lookup policy
- `.claude/skills/create-task/SKILL.md` — first-pass lookup policy
- `docs/backlog/README.md` — operator instructions

---

## Goals

1. Must generate a single JSON index summarizing all markdown backlog task files.
2. Must include, at minimum, task number, title, slug, path, ref if available, epic if available, and dependency note.
3. Must tolerate mixed task-file formats by extracting metadata from frontmatter when present and falling back to filename and heading parsing when absent.
4. Must let the create-task skills use the index as the first-pass duplicate and overlap lookup before opening full task files.
5. Must preserve markdown files as the authoritative source of task details.

---

## Implementation

### Step 1 — Build a backlog index generator with mixed-format fallback

**File:** `scripts/backlog-index.mjs`

Implement a script that:
- scans `docs/backlog/*.md`
- parses frontmatter when present
- reads the first heading and dependency line
- derives `number` and `slug` from the filename
- writes a sorted JSON array to `docs/backlog/index.json`

Expected output shape:

```json
[
  {
    "number": 126,
    "slug": "generate-backlog-task-index",
    "title": "Generate Backlog Task Index",
    "path": "docs/backlog/126-generate-backlog-task-index.md",
    "ref": "orch/task-126-generate-backlog-task-index",
    "epic": "orch",
    "dependency_note": "Independent."
  }
]
```

### Step 2 — Update the skills to read the index before scanning markdown bodies

**File:** `.codex/skills/create-task/SKILL.md`

**File:** `.claude/skills/create-task/SKILL.md`

Replace broad "read 1-2 recent tasks" guidance with:
- read `docs/backlog/index.json` first
- shortlist overlapping tasks by title/ref/slug/epic
- open full markdown files only for shortlisted tasks or final style reference

### Step 3 — Document regeneration workflow

**File:** `docs/backlog/README.md`

Document:
- the purpose of `docs/backlog/index.json`
- how to regenerate it with `node scripts/backlog-index.mjs`
- that markdown remains authoritative and the index is a generated summary only

---

## Acceptance criteria

- [ ] `scripts/backlog-index.mjs` generates `docs/backlog/index.json` from all numbered markdown task files.
- [ ] `docs/backlog/index.json` contains one entry per numbered task file with number, slug, title, path, and dependency note.
- [ ] Entries include `ref` and `epic` when frontmatter exists, and omit them cleanly when it does not.
- [ ] The generator works against the current mixed backlog without requiring manual edits to historical task files.
- [ ] A malformed markdown task file is skipped with a descriptive warning or fails deterministically with a descriptive error; it is never silently omitted.
- [ ] Both create-task skills instruct the agent to read `docs/backlog/index.json` before opening full task files for overlap detection.
- [ ] `docs/backlog/README.md` documents regeneration and clarifies that the index is generated, not authoritative.
- [ ] No changes to `orc-state/backlog.json` or MCP handler code.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `scripts/backlog-index.test.mjs`:

```js
it('generates an index entry for each numbered backlog task file');
it('falls back to filename and heading when frontmatter is absent');
it('preserves frontmatter ref and epic when present');
```

Use fixture markdown files in a temp directory and assert against the generated JSON output. Do not rely on manual inspection alone.

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
node scripts/backlog-index.mjs
```

```bash
node --input-type=module -e "import { readFileSync } from 'node:fs'; const data = JSON.parse(readFileSync('docs/backlog/index.json', 'utf8')); console.log(data.length);"
```

```bash
rg -n "index.json|generated summary|authoritative" docs/backlog/README.md .codex/skills/create-task/SKILL.md .claude/skills/create-task/SKILL.md
```

## Risk / Rollback

**Risk:** If `scripts/backlog-index.mjs` writes a partial or malformed `docs/backlog/index.json`, later task-creation runs may rely on incomplete metadata and miss overlapping tasks. The script must write the index atomically or fail before replacing the previous file.
**Rollback:** `git restore scripts/backlog-index.mjs docs/backlog/index.json docs/backlog/README.md .codex/skills/create-task/SKILL.md .claude/skills/create-task/SKILL.md && npm test`
