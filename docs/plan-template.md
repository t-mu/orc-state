---
plan_id: 0
name: <feature-slug>
title: <Human readable plan title>
created_at: 1970-01-01T00:00:00Z
updated_at: 1970-01-01T00:00:00Z
derived_task_refs: []
---

# <Plan title>

## Objective

One or two sentences describing the outcome this plan achieves.

## Scope

Concrete outcomes this plan delivers. One bullet per outcome.

## Out of Scope

Work explicitly excluded from this plan. One bullet per exclusion.

## Constraints

Hard constraints that bound the implementation — systems that must not change,
invariants that must hold, performance or compatibility requirements.

## Affected Areas

Files, modules, or subsystems this plan touches. One bullet per area.

## Implementation Steps

Ordered, atomic steps. Each step is a numbered or `###` heading followed by a
body describing the work. Include explicit dependencies on earlier steps using
the exact structured cue `Depends on: N` (or `Depends on: N, M`) — this cue is
specific to plan artifacts. Backlog specs continue to use the prose
`Depends on Task N.` form.

### Step 1 — First step title

Description of the first step's work.

### Step 2 — Second step title

Description of the second step's work.

Depends on: 1
