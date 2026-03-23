---
ref: general/21-delegation-depth-and-blocked-tools
feature: general
priority: normal
status: done
---

# Task 21 — Enforce Delegation Depth Limit and Blocked-Tool Constraints in Worker Bootstrap

Independent. Blocks no other task.

## Scope

**In scope:**
- Add a sub-agent constraint section to `templates/worker-bootstrap-v2.txt` that explicitly prohibits reviewer sub-agents from calling any `orc run-*` lifecycle commands, state-mutation commands, or spawning further delegates
- The new section must enumerate the four specific constraints listed in Goals

**Out of scope:**
- Changes to the coordinator dispatch logic, claim manager, or MCP tools
- Changes to the master bootstrap template
- Any runtime enforcement — this is a prompt-level constraint only
- Changes to `lib/sessionBootstrap.ts` or any TypeScript source

---

## Context

Workers are instructed by `templates/worker-bootstrap-v2.txt` (step 6b) to spawn two independent sub-agent reviewers that receive `git diff main` and the acceptance criteria as context. The template currently places no restrictions on what those sub-agents may do inside their own Claude Code session.

A sub-agent reviewer that becomes confused about its role could call `orc run-finish`, `orc run-fail`, or `orc run-work-complete` — all of which write to shared state and would terminate or corrupt the parent run. This is a real failure mode: the reviewer has full bash access and can see the same `orc` CLI that the parent worker uses.

Hermes-agent solves an equivalent problem via `DELEGATE_BLOCKED_TOOLS` (a frozenset) and a `MAX_DEPTH` check. The equivalent here is a prompt-level constraint communicated to the parent worker so it passes those constraints to sub-agents at spawn time.

### Current state

`templates/worker-bootstrap-v2.txt` step 6b reads:

```
b. Spawn two independent sub-agents. Give each the acceptance criteria and the
   output of `git diff main` as context. Ask each to review the changes and
   return a list of findings (or "approved").
```

No constraints on sub-agent behavior are stated.

### Desired state

Step 6b is extended to include a mandatory constraint block that workers must pass verbatim when spawning reviewer sub-agents. The constraints: (1) no `orc run-*` commands, (2) no backlog/claim mutation commands, (3) no further sub-agent spawning, (4) reviewer role is read-only analysis only.

### Start here

- `templates/worker-bootstrap-v2.txt` — the only file to change; inspect the full step 6 block starting at line 67

**Affected files:**
- `templates/worker-bootstrap-v2.txt` — worker behavior instructions; step 6b sub-agent spawning section

---

## Goals

1. Must add an explicit constraint block to the sub-agent reviewer spawning instruction in `templates/worker-bootstrap-v2.txt`.
2. Must prohibit reviewer sub-agents from calling any `orc run-*` command (`run-start`, `run-heartbeat`, `run-work-complete`, `run-finish`, `run-fail`, `run-input-request`).
3. Must prohibit reviewer sub-agents from calling `orc task-mark-done`, `orc delegate`, or any other command that writes to `backlog.json` or `claims.json`.
4. Must prohibit reviewer sub-agents from spawning further sub-agents (depth limit: sub-agents operate at MAX_DEPTH=1 from the worker context).
5. Must instruct workers to communicate these constraints explicitly in the prompt they pass when spawning each reviewer.
6. Must not alter the surrounding template structure or break any existing template rendering tests.

---

## Implementation

### Step 1 — Extend the sub-agent reviewer spawning instruction

**File:** `templates/worker-bootstrap-v2.txt`

Locate step 6b (currently around line 70–75). Replace it with an expanded version that includes a mandatory constraint block:

```text
       b. Spawn two independent sub-agents. Give each:
          - The acceptance criteria for this task
          - The output of `git diff main`
          - The following MANDATORY CONSTRAINTS block verbatim:

          --- REVIEWER CONSTRAINTS (read this before doing anything) ---
          You are a code reviewer sub-agent operating at MAX_DEPTH=1.
          Your only role is to read the diff and acceptance criteria, identify
          any issues, and return findings as text (or "approved" if none).

          You MUST NOT call any of the following commands:
            orc run-start, orc run-heartbeat, orc run-work-complete,
            orc run-finish, orc run-fail, orc run-input-request,
            orc task-mark-done, orc delegate, orc task-reset,
            orc task-unblock, orc kill-all
          You MUST NOT write to backlog.json, claims.json, or events.jsonl.
          You MUST NOT spawn further sub-agents or delegates.
          You MUST NOT make any file edits, commits, or git operations.
          Return ONLY a list of findings or the single word "approved".
          --- END REVIEWER CONSTRAINTS ---
```

Invariant: do not change any other step in the template. The overall step numbering and surrounding prose must remain identical.

---

## Acceptance criteria

- [ ] `templates/worker-bootstrap-v2.txt` contains a `REVIEWER CONSTRAINTS` block within the sub-agent spawning instruction.
- [ ] The constraints block explicitly names `orc run-start`, `orc run-heartbeat`, `orc run-work-complete`, `orc run-finish`, `orc run-fail`, and `orc run-input-request` as prohibited.
- [ ] The constraints block explicitly names `orc task-mark-done` and `orc delegate` as prohibited.
- [ ] The constraints block states MAX_DEPTH=1 and prohibits further sub-agent spawning.
- [ ] The constraints block states that no file edits, commits, or git operations are permitted.
- [ ] Workers are instructed to pass the constraints block verbatim to each reviewer at spawn time.
- [ ] `npm test` passes with no regressions.
- [ ] No changes to files outside the stated scope.

---

## Tests

The template is a plain text file; no direct unit tests exist for its content. Verify via:

Add to `lib/sessionBootstrap.test.ts` (or a new `templates/worker-bootstrap.test.ts`):

```ts
it('worker bootstrap template contains REVIEWER CONSTRAINTS block', () => {
  const content = readFileSync('templates/worker-bootstrap-v2.txt', 'utf8');
  expect(content).toContain('REVIEWER CONSTRAINTS');
  expect(content).toContain('orc run-finish');
  expect(content).toContain('orc task-mark-done');
  expect(content).toContain('MAX_DEPTH=1');
});
```

---

## Verification

```bash
npx vitest run lib/sessionBootstrap.test.ts
```

```bash
nvm use 24 && npm test
```
