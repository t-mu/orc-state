---
ref: <feature>/<slug>
feature: <feature>
title: <Imperative title>
priority: normal
review_level: full
# depends_on:
#   - <feature>/<slug>
# required_provider: claude
# task_type: implementation
# merge_strategy: direct
# model: <provider model id>
---

<!-- Frontmatter: `ref` is required (`^[a-z0-9-]+/[a-z0-9-]+$`), its prefix must equal `feature`.
     `title` defaults to the first `# ` heading. priority: low|normal|high|critical.
     review_level: none|light|full (default full). task_type: implementation|refactor.
     merge_strategy: direct|pr. Dependencies go only in `depends_on:`; prose is not parsed.
     No `status:`: it is runtime-owned (ignored on import, rejected with `--strict`). -->

# <Imperative title>

## Scope

**In scope:**
- <!-- one concrete outcome per bullet -->

**Out of scope:**
- <!-- files, systems or concerns that must not change -->

## Context

### Current state
<!-- 2-5 lines: how it behaves today and what is wrong or missing -->

### Desired state
<!-- 2-5 lines: the end state after this task -->

### Start here
- `path/to/file.ts` — <!-- first file to read and its role -->

## Implementation

### Step 1 — <description>
<!-- file, expected change, invariants to preserve -->

## Acceptance criteria
<!-- Parsed: each `- [ ]` item under this heading becomes the task's acceptance_criteria,
     handed to reviewers. Binary, observable, at least one failure/edge case. -->

- [ ] ...
- [ ] No changes to files outside the stated scope.

## Verification

```bash
npx vitest run path/to/file.test.ts   # narrowest proof first
npm test                              # required before run-work-complete
orc doctor                            # only when schema, state or CLI changes are in scope
```

## Risk / Rollback
<!-- Only when the task changes state files, schemas or npm scripts. -->
