---
ref: craftsmanship-foundations/80-reduce-prompt-regex-fragility
feature: craftsmanship-foundations
priority: low
status: done
---

# Task 80 — Reduce Blocking Prompt Regex Fragility

Independent.

## Scope

**In scope:**
- Document known prompt patterns in `adapters/pty.ts`
- Add tests for `detectBlockingPromptFromText` if missing
- Consider consolidating overlapping regex patterns

**Out of scope:**
- Rewriting the prompt detection system
- Adding new detection heuristics

---

## Context

### Current state

`BLOCKING_PROMPT_PATTERNS` in `adapters/pty.ts` (line 46) uses 5 overlapping regexes for detecting y/n prompts. These are fragile to provider CLI updates and some patterns overlap.

### Desired state

Consolidated regex patterns with documentation explaining each, plus test coverage for the detection function.

### Start here

- `adapters/pty.ts` — lines 46-52, 147-169

**Affected files:**
- `adapters/pty.ts` — consolidate and document regexes
- `adapters/pty.test.ts` — add detection tests if missing

---

## Goals

1. Must document each regex pattern's purpose
2. Must consolidate obviously overlapping patterns
3. Must add tests for prompt detection
4. Must not change detection behavior for known prompt formats

---

## Acceptance criteria

- [ ] Each regex has a comment explaining what it catches
- [ ] Overlapping patterns consolidated where safe
- [ ] Test coverage for `detectBlockingPromptFromText`
- [ ] `npm test` passes

---

## Verification

```bash
npx vitest run adapters/pty.test.ts
```

```bash
npm test
```

---

## Tests

New tests are part of the core deliverable for this task. See acceptance criteria.
