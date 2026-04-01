---
ref: publish/96-prepublish-guard-and-files-audit
feature: publish
priority: normal
status: done
depends_on:
  - publish/94-emit-dts-declarations
---

# Task 96 — Add prepublishOnly Guard and Audit files List

Depends on Task 94 (needs build:types script to exist).

## Scope

**In scope:**
- Add `"prepublishOnly": "npm run build:types && npm test"` to `package.json` scripts
- Remove `contracts.md` from the `files` array (only referenced in tests, not at runtime)
- Verify `skills/`, `templates/`, `mcp/` remain in `files` (all loaded at runtime)
- Verify final `npm pack --dry-run` file count and size

**Out of scope:**
- Removing skills/, templates/, or mcp/ from the package
- Changing any runtime code
- Adding a CHANGELOG or release process

---

## Context

There is no guard preventing `npm publish` without generating declarations or running tests. The `files` array also includes `contracts.md` which is never read at runtime (only in `lib/prompts.test.ts`).

### Current state
- No `prepublishOnly` script
- `contracts.md` in `files` array — only referenced in test files
- `skills/` and `templates/` in `files` — loaded at runtime by `templateRender.ts` and `install-skills.ts` via `import.meta.url`
- `mcp/` in `files` — needed for `orc mcp-server` subcommand
- 214 files / 230 KB in tarball

### Desired state
- `prepublishOnly` prevents accidental publish without build + tests
- `contracts.md` removed from `files` (still in repo, just not shipped)
- File count reduced slightly; skills/, templates/, mcp/ confirmed as necessary
- Clean `npm pack --dry-run` output

### Start here
- `package.json` — `scripts` and `files` fields
- `lib/templateRender.ts` — confirms templates/ runtime usage
- `cli/install-skills.ts` — confirms skills/ runtime usage

**Affected files:**
- `package.json` — `scripts.prepublishOnly`, `files` array

---

## Goals

1. Must: `"prepublishOnly"` script exists and runs `build:types` + `test`.
2. Must: `contracts.md` is not in the `files` array.
3. Must: `skills/`, `templates/`, `mcp/` remain in the `files` array.
4. Must: `npm pack --dry-run` exits 0 with no warnings.

---

## Implementation

### Step 1 — Add prepublishOnly

**File:** `package.json`

```json
"prepublishOnly": "npm run build:types && npm test"
```

### Step 2 — Remove contracts.md from files

**File:** `package.json`

Remove `"contracts.md"` from the `files` array.

---

## Acceptance criteria

- [ ] `package.json` `scripts.prepublishOnly` equals `"npm run build:types && npm test"`.
- [ ] `package.json` `files` does not include `"contracts.md"`.
- [ ] `package.json` `files` includes `"skills"`, `"templates"`, `"mcp"`.
- [ ] `npm pack --dry-run` exits 0.
- [ ] `npm test` passes.

---

## Tests

No new tests. Validation via `npm pack --dry-run`.

---

## Verification

```bash
# Confirm prepublishOnly exists
node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log(p.scripts.prepublishOnly)"

# Confirm contracts.md not in files
node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('contracts.md in files:', p.files.includes('contracts.md'))"

# Confirm pack is clean
npm pack --dry-run

# Full suite
npm test
```

---

## Risk / Rollback

**Risk:** Minimal — adding a script and removing one non-runtime file from the package.
**Rollback:** `git restore package.json`
