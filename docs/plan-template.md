---
# Canonical plan format, parsed by `parsePlan` in lib/planDocs.ts
# (`orc project plan import` reads it, `orc project plan export` writes it).
#   - Frontmatter (all required): plan_id (non-negative integer, own sequence, may collide
#     with task numbers), name (`^[a-z][a-z0-9-]*$`), title, created_at, updated_at,
#     derived_task_refs (`[]`, inline `[a/b, c/d]`, or a `  - ref` list).
#   - Required `##` sections (any order): Objective, Scope, Out of Scope, Constraints,
#     Affected Areas, Implementation Steps.
#   - Implementation Steps holds only `### Step N — Title` headings (`—` or `-`); step
#     numbers are unique; any other `###` heading is rejected.
#   - Dependencies: a line `Depends on: N` or `Depends on: N, M` in a step body.
#     Task specs use `depends_on:` frontmatter instead.
#   - Body must not contain TBD, TODO, `???`, or `[bracketed]` text outside fenced code
#     and `[text](url)` links.
#   - UTF-8, no byte-order mark.
plan_id: 0
name: <feature-slug>
title: <Human readable plan title>
created_at: 1970-01-01T00:00:00Z
updated_at: 1970-01-01T00:00:00Z
derived_task_refs: []
---

# <Plan title>

## Objective

<!-- 1-2 sentences: the outcome. -->

## Scope

- <!-- one deliverable per bullet -->

## Out of Scope

- <!-- one exclusion per bullet -->

## Constraints

- <!-- invariants, systems that must not change, compatibility -->

## Affected Areas

- <!-- one file, module or subsystem per bullet -->

## Implementation Steps

### Step 1 — First step title

<!-- the work of this step -->

### Step 2 — Second step title

<!-- the work of this step -->

Depends on: 1
