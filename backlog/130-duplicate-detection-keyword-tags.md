---
ref: memory-foundation/130-duplicate-detection-keyword-tags
feature: memory-foundation
priority: normal
status: todo
depends_on:
  - memory-foundation/129-drawer-crud-spatial-coordinates
---

# Task 130 — Add Duplicate Detection and Keyword Tagging

Depends on Task 129. Blocks Task 137.

## Scope

**In scope:**
- SHA-256 content hash column (`content_hash`) population on insert
- Duplicate check in `storeDrawer()` — return existing ID when content hash matches
- Keyword extraction function that generates tags from content
- Auto-populate `tags` field on insert when not explicitly provided

**Out of scope:**
- FTS5 search ranking or snippets (Task 131)
- Semantic similarity detection (out of scope entirely — FTS5 only)

---

## Context

### Current state

Task 129's `storeDrawer()` inserts any content without checking for duplicates.
The `content_hash` and `tags` columns exist in the schema (Task 128) but are not populated.

### Desired state

`storeDrawer()` computes a SHA-256 hash of normalized content and checks for duplicates
before inserting. When a duplicate is found, the existing drawer ID is returned.
When tags are not provided, keywords are auto-extracted from content.

### Start here

- `lib/memoryStore.ts` — `storeDrawer()` function from Task 129

**Affected files:**
- `lib/memoryStore.ts` — modify `storeDrawer()`, add `extractKeywords()` helper

---

## Goals

1. Must compute SHA-256 hash of content (trimmed, lowercased) and store in `content_hash`.
2. Must check `content_hash` for duplicates before insert; return existing ID on match.
3. Must extract top-20 keywords from content when `tags` is not explicitly provided.
4. Must filter English stopwords from keyword extraction.

---

## Implementation

### Step 1 — Add content hashing and duplicate check

**File:** `lib/memoryStore.ts`

Modify `storeDrawer()` to:
1. Compute `SHA-256(content.trim().toLowerCase())` using `crypto.createHash`.
2. Query `SELECT id FROM drawers WHERE content_hash = ?`.
3. If found, return existing ID without inserting.
4. Otherwise, insert with `content_hash` populated.

### Step 2 — Add keyword extraction

**File:** `lib/memoryStore.ts`

```ts
const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
  'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then', 'once',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither',
  'this', 'that', 'these', 'those', 'it', 'its', 'he', 'she', 'they', 'them',
  'we', 'you', 'i', 'me', 'my', 'our', 'your', 'his', 'her', 'their']);

export function extractKeywords(text: string, maxCount = 20): string {
  const words = text.toLowerCase().split(/[^a-z0-9_-]+/).filter(w => w.length > 2 && !STOPWORDS.has(w));
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxCount).map(e => e[0]).join(',');
}
```

Wire into `storeDrawer()`: if `input.tags` is not provided, call `extractKeywords(input.content)`.

---

## Acceptance criteria

- [ ] `storeDrawer()` populates `content_hash` on every insert
- [ ] Storing identical content twice returns the same ID without creating a duplicate
- [ ] Storing different content with same wing/room creates two separate drawers
- [ ] Keywords are auto-extracted when `tags` is not explicitly provided
- [ ] Explicit `tags` input is preserved as-is (not overwritten by auto-extraction)
- [ ] Stopwords are filtered from auto-extracted keywords
- [ ] No changes to files outside the stated scope

---

## Tests

Add to `lib/memoryStore.test.ts`:

```ts
it('populates content_hash on insert', () => { ... });
it('returns existing ID for duplicate content', () => { ... });
it('auto-extracts keywords when tags not provided', () => { ... });
it('preserves explicit tags without overwriting', () => { ... });
it('filters stopwords from extracted keywords', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/memoryStore.test.ts
```

```bash
nvm use 24 && npm test
```
