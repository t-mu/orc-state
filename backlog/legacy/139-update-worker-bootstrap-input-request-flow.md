---
ref: orch/task-139-update-worker-bootstrap-input-request-flow
epic: orch
status: done
---

# Task 139 — Update Worker Bootstrap and AGENTS.md with Input Request Flow

Depends on Task 136. Blocks Task 140 (parallel-safe).

## Scope

**In scope:**
- `templates/worker-bootstrap-v2.txt` — replace INTERACTIVE PROMPT RULE with the new `orc-run-input-request` flow
- `AGENTS.md` — replace Interactive Prompt Rule section with the same flow

**Out of scope:**
- Any changes to CLI, MCP, coordinator, or schema files
- Master bootstrap templates — Task 140
- Changes to any other section of worker-bootstrap-v2.txt or AGENTS.md

---

## Context

Tasks 136–138 deliver the infrastructure for the worker input request flow. This task updates the agent-facing instructions so workers know how to use it. The current INTERACTIVE PROMPT RULE in both files tells workers to call `orc-run-fail` when blocked on an interactive prompt — that should be replaced with the new polling flow using `orc-run-input-request`.

The instructions must be universal and provider-agnostic — no "Claude only" or "Codex only" qualifiers.

**Affected files:**
- `templates/worker-bootstrap-v2.txt` — INTERACTIVE PROMPT RULE section
- `AGENTS.md` — Interactive Prompt Rule section

---

## Goals

1. Must replace the current INTERACTIVE PROMPT RULE in `worker-bootstrap-v2.txt` with the `orc-run-input-request` polling flow.
2. Must replace the current Interactive Prompt Rule in `AGENTS.md` with the same flow.
3. Must include the timeout fallback: if `orc-run-input-request` exits 1, call `orc-run-fail`.
4. Must contain no provider-specific language.
5. Must not modify any other section of either file.

---

## Implementation

### Step 1 — Update `worker-bootstrap-v2.txt`

**File:** `templates/worker-bootstrap-v2.txt`

Replace the existing INTERACTIVE PROMPT RULE block with:

```
INTERACTIVE PROMPT RULE

If you encounter an interactive confirmation prompt you cannot bypass:

  1. Ask the master for a decision:
       RESPONSE=$(orc-run-input-request \
         --run-id=<run_id> \
         --agent-id=<agent_id> \
         --question="<describe exactly what is being asked and why>")

  2. If the command exits 0, $RESPONSE contains the master's answer.
     Use it to answer the original prompt and continue.

  3. If the command exits 1 (timeout — no response after 25 min):
       orc-run-fail --run-id=<run_id> --agent-id=<agent_id> \
         --reason="No response received for input request: <question>"
     Then clean up the worktree and stop.
```

### Step 2 — Update `AGENTS.md`

**File:** `AGENTS.md`

Replace the existing Interactive Prompt Rule section with the same content, adapted to markdown:

```markdown
## Interactive Prompt Rule

If you encounter an interactive confirmation prompt you cannot bypass:

1. Ask the master for a decision:
   ```bash
   RESPONSE=$(orc-run-input-request \
     --run-id=<run_id> \
     --agent-id=<agent_id> \
     --question="<describe exactly what is being asked and why>")
   ```
2. If the command exits 0, `$RESPONSE` contains the master's answer. Use it to answer the prompt and continue.
3. If the command exits 1 (25-minute timeout — no response received), call `orc-run-fail` and clean up the worktree.
```

---

## Acceptance criteria

- [ ] `worker-bootstrap-v2.txt` INTERACTIVE PROMPT RULE instructs workers to use `orc-run-input-request`.
- [ ] `AGENTS.md` Interactive Prompt Rule section instructs workers to use `orc-run-input-request`.
- [ ] Both files include the timeout fallback to `orc-run-fail`.
- [ ] Neither file contains provider-specific language in the prompt rule.
- [ ] No other section of either file is modified.
- [ ] No changes to files outside the stated scope.

---

## Tests

No automated tests — these are instructional text files. Verify manually that both files render the correct flow after editing.

---

## Verification

```bash
grep -A 10 "INTERACTIVE PROMPT RULE" templates/worker-bootstrap-v2.txt
grep -A 10 "Interactive Prompt Rule" AGENTS.md
```

Both should reference `orc-run-input-request`, not `orc-run-fail` as the primary action.
