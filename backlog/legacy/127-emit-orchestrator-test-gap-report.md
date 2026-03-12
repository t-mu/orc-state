---
ref: orch/task-127-emit-orchestrator-test-gap-report
epic: orch
status: done
---

# Task 127 — Emit Orchestrator Test Gap Report

Depends on Task 126. Blocks Task 128 and Task 129 because later prompt-workflow tasks should preserve the manifest-first testing guidance.

## Scope

**In scope:**
- `scripts/test-gap-report.mjs` — generate a source-to-test mapping for the `orchestrator/` package
- `orchestrator/test-manifest.json` — generated machine-readable artifact summarizing source/test pairing
- `.codex/skills/create-task/SKILL.md` — instruct the task-creation workflow to read the manifest first for test-gap prompts
- `.claude/skills/create-task/SKILL.md` — same manifest-first guidance
- `orchestrator/README.md` — document how to regenerate the report

**Out of scope:**
- Enabling line or branch coverage collection in Vitest
- Maintaining missing-branch annotations by hand
- Changing production source files under `orchestrator/`

---

## Context

Testing-related task prompts are expensive because the agent must infer source-to-test relationships from directory scans every time. The cheapest useful optimization is not full coverage analytics; it is a deterministic mapping artifact that says which `orchestrator/` source files appear to have unit tests and which do not.

This can be generated with straightforward path heuristics. For example, `lib/foo.mjs` should usually map to `lib/foo.test.mjs`, while integration and e2e tests should be classified separately. That is enough to narrow the candidate file set before any deeper inspection.

The artifact should be generated, not hand-maintained, and it should be explicit about heuristic confidence so the agent treats it as a first-pass aid rather than as perfect truth.

**Affected files:**
- `scripts/test-gap-report.mjs` — report generator
- `orchestrator/test-manifest.json` — generated source/test mapping
- `.codex/skills/create-task/SKILL.md` — testing-task guidance
- `.claude/skills/create-task/SKILL.md` — testing-task guidance
- `orchestrator/README.md` — regeneration instructions

---

## Goals

1. Must generate a machine-readable source-to-test manifest for files under `orchestrator/`.
2. Must classify tests by at least `unit`, `integration`, and `e2e` based on deterministic path rules.
3. Must mark likely missing unit tests using filename/path heuristics rather than manual annotation.
4. Must let the task-creation skills consult the manifest first when the user asks for test-audit or missing-test backlog tasks.
5. Must avoid introducing a manual maintenance burden for coverage metadata.

---

## Implementation

### Step 1 — Generate a deterministic source-to-test manifest

**File:** `scripts/test-gap-report.mjs`

Implement a script that:
- enumerates source files under `orchestrator/`
- enumerates `*.test.mjs` files under `orchestrator/`
- matches likely unit tests by basename/path
- classifies test files as `unit`, `integration`, or `e2e`
- writes `orchestrator/test-manifest.json`

Expected output shape:

```json
[
  {
    "source": "lib/eventLog.mjs",
    "tests": ["lib/eventLog.test.mjs"],
    "has_unit_test": true,
    "likely_missing_unit_test": false,
    "categories": ["unit"]
  }
]
```

### Step 2 — Update task-creation skills for testing prompts

**File:** `.codex/skills/create-task/SKILL.md`

**File:** `.claude/skills/create-task/SKILL.md`

Add guidance:
- for test-gap or coverage-related prompts, read `orchestrator/test-manifest.json` first
- shortlist only files flagged as likely missing or weakly matched
- inspect raw test/source files only after the shortlist is formed

### Step 3 — Document regeneration and limits

**File:** `orchestrator/README.md`

Document:
- how to run `node scripts/test-gap-report.mjs`
- that the manifest is heuristic
- that it is intended to reduce search cost, not replace source inspection entirely

---

## Acceptance criteria

- [ ] `scripts/test-gap-report.mjs` generates `orchestrator/test-manifest.json` from the current repo layout.
- [ ] Each manifest entry includes `source`, `tests`, `has_unit_test`, `likely_missing_unit_test`, and `categories`.
- [ ] Integration and e2e tests are classified separately from unit tests.
- [ ] Files without an obvious unit test counterpart are flagged as likely missing rather than silently omitted.
- [ ] If the generator encounters an unreadable source or test path, it exits with a descriptive error instead of emitting a silently partial manifest.
- [ ] Both create-task skills instruct the agent to consult the manifest first for testing-related prompts.
- [ ] Documentation states clearly that the manifest is generated and heuristic.
- [ ] No production source files under `orchestrator/` are modified.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `scripts/test-gap-report.test.mjs`:

```js
it('matches a source file to its sibling unit test');
it('classifies integration and e2e tests separately from unit tests');
it('flags source files with no obvious unit test as likely missing');
```

Use fixture source/test directory layouts in a temp directory and assert against the generated manifest. Do not leave this as manual-only verification.

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
node scripts/test-gap-report.mjs
```

```bash
node --input-type=module -e "import { readFileSync } from 'node:fs'; const data = JSON.parse(readFileSync('orchestrator/test-manifest.json', 'utf8')); console.log(data.filter((x) => x.likely_missing_unit_test).slice(0, 10));"
```

```bash
rg -n "test-manifest.json|heuristic|consult the manifest first" .codex/skills/create-task/SKILL.md .claude/skills/create-task/SKILL.md orchestrator/README.md
```

## Risk / Rollback

**Risk:** If `scripts/test-gap-report.mjs` emits a partial or malformed `orchestrator/test-manifest.json`, later testing-related task creation may shortlist the wrong files or miss actual gaps. The script must replace the manifest atomically or fail before writing it.
**Rollback:** `git restore scripts/test-gap-report.mjs scripts/test-gap-report.test.mjs orchestrator/test-manifest.json orchestrator/README.md .codex/skills/create-task/SKILL.md .claude/skills/create-task/SKILL.md && npm test`
