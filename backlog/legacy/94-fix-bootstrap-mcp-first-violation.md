# Task 94 — Fix Master Bootstrap MCP-First Violation and Failing templateRender Test

Independent. Blocks Task 95 (depends on correct bootstrap content).

## Scope

**In scope:**
- `templates/master-bootstrap-v1.txt` — replace the `orc-master-check` CLI reference in FALLBACK CHECK with an MCP-based equivalent
- `lib/templateRender.test.mjs` — confirm the `not.toContain('orc-')` assertion passes after the fix

**Out of scope:**
- `cli/master-check.mjs` — the CLI tool itself is unchanged; it remains available for operators
- Task 93 (`notify-93-bootstrap-update`) content — preserve NOTIFICATIONS and FALLBACK CHECK sections; only change the mechanism referenced

---

## Context

`templateRender.test.mjs` contains an assertion:

```js
it('keeps master bootstrap MCP-first without CLI command instructions', () => {
  expect(rendered).not.toContain('orc-');
});
```

This test currently **fails** because `master-bootstrap-v1.txt` line 76 contains:

```
  Bash: orc-master-check
```

The bootstrap design principle is that the master agent uses MCP tools exclusively for
orchestrator state queries. The `FALLBACK CHECK` section added in Task 93 violates this by
directing Claude to run a shell command. The fix is to replace the CLI reference with an
equivalent MCP-based check: `list_tasks(status='done')` or `get_recent_events()`.

**Affected files:**
- `templates/master-bootstrap-v1.txt` — line 76, FALLBACK CHECK section
- `lib/templateRender.test.mjs` — the failing assertion

---

## Goals

1. Must replace `Bash: orc-master-check` with MCP tool calls that achieve the same result.
2. Must keep the FALLBACK CHECK section; only the mechanism changes.
3. Must cause `templateRender.test.mjs` to pass with zero failures.
4. Must not add any new `orc-` references to the bootstrap template.
5. Must preserve all other bootstrap sections unchanged.

---

## Implementation

### Step 1 — Rewrite FALLBACK CHECK in `master-bootstrap-v1.txt`

**File:** `templates/master-bootstrap-v1.txt`

Replace the current FALLBACK CHECK section:

```
FALLBACK CHECK

If you have not received a TASK_COMPLETE notification but suspect workers
may have finished (e.g. after a long pause), run:
  Bash: orc-master-check

This prints any unconsumed pending notifications from the queue.
After reviewing, inform the user of any completed tasks you find.
```

With:

```
FALLBACK CHECK

If you have not received a TASK_COMPLETE notification but suspect workers
may have finished (e.g. after a long pause), check via MCP tools:

  list_tasks(status="done")       — see recently completed tasks
  get_recent_events(limit=20)     — see latest coordinator activity

Review the output and inform the user of any completed tasks you find,
then ask: 1) Ignore for now  2) React immediately
```

### Step 2 — Verify the test passes

**File:** `lib/templateRender.test.mjs`

No code change needed — the test already has the correct assertion. Run to confirm:

```bash
npx vitest run -c orchestrator/vitest.config.mjs lib/templateRender.test.mjs
```

Expected: all tests pass, including `keeps master bootstrap MCP-first without CLI command instructions`.

---

## Acceptance criteria

- [ ] `master-bootstrap-v1.txt` contains no `orc-` substrings.
- [ ] FALLBACK CHECK section is still present and instructs Claude to check via `list_tasks` and `get_recent_events`.
- [ ] `templateRender.test.mjs` passes with 0 failures.
- [ ] NOTIFICATIONS, READ STATE, WRITE STATE, RESOURCES, TYPICAL FLOW, and INVARIANTS sections are unchanged.
- [ ] `nvm use 24 && npm test` passes with no new failures.
- [ ] No changes to files outside the stated scope.

---

## Tests

No new tests required — the existing assertion in `templateRender.test.mjs` is the verification.

```bash
npx vitest run -c orchestrator/vitest.config.mjs lib/templateRender.test.mjs
```

---

## Verification

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Minimal — template-only change with no stateful side effects.
**Rollback:** `git restore templates/master-bootstrap-v1.txt`
