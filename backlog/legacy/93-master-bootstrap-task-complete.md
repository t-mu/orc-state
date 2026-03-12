# Task 93 — Update Master Bootstrap: TASK_COMPLETE Handling and Fallback Check

Depends on Tasks 91 and 92.

## Scope

**In scope:**
- `templates/master-bootstrap-v1.txt` — add `NOTIFICATIONS` and `FALLBACK CHECK` sections

**Out of scope:**
- Any code changes — this is a template-only update
- Worker bootstrap template (`worker-bootstrap-v2.txt`)
- The MCP tool documentation sections (`READ STATE`, `WRITE STATE`, `RESOURCES`, `TYPICAL FLOW`, `INVARIANTS`) — must remain unchanged

---

## Context

Without bootstrap instructions, Claude has no schema for the `[ORCHESTRATOR] TASK_COMPLETE`
block injected by the PTY forwarder (Task 91) and no knowledge that `orc-master-check` (Task 92)
exists as a fallback. This task gives Claude the context to:

- Recognize the notification format and surface it to the user
- Offer a structured choice: ignore vs react now
- Use `orc-master-check` when PTY injection is unavailable (resumed session, forwarder down)

The notification format added to the bootstrap must exactly match what
`lib/masterPtyForwarder.mjs` injects (see Task 91 implementation).

**Affected files:**
- `templates/master-bootstrap-v1.txt`

---

## Goals

1. Must add a `NOTIFICATIONS` section explaining how to handle `[ORCHESTRATOR] TASK_COMPLETE` blocks.
2. Must instruct Claude to present the user with exactly two choices: 1) Ignore for now, 2) React immediately.
3. Must add a `FALLBACK CHECK` section instructing Claude to run `orc-master-check` after long pauses.
4. Must preserve the `MASTER_BOOTSTRAP_END` sentinel at the end of the file.
5. Must not alter any existing section content.

---

## Implementation

### Step 1 — Add sections to bootstrap template

**File:** `templates/master-bootstrap-v1.txt`

Insert the following two sections between the `INVARIANTS` section and the `MASTER_BOOTSTRAP_END` line:

```
NOTIFICATIONS

When you receive a block beginning with [ORCHESTRATOR] TASK_COMPLETE, do the
following immediately:

1. Tell the user which task finished, which worker completed it, and whether
   it succeeded or failed.
2. Ask the user to choose:
     1) Ignore for now — continue the current conversation
     2) React immediately — review the result and decide next steps
3. Wait for the user's choice before proceeding.

If the user chooses option 2, call get_task(task_ref) to review what was
done, then propose follow-up actions (e.g. delegate a dependent task, flag
a failure for investigation).

FALLBACK CHECK

If you suspect workers may have finished tasks but you have not received a
TASK_COMPLETE notification (e.g. after resuming a session or a long pause),
run the following shell command:

  orc-master-check

This prints any unconsumed pending notifications from the queue file.
After reviewing the output, inform the user of any completed tasks found.
```

The final file must end with `MASTER_BOOTSTRAP_END` on its own line (no trailing blank line after it).

---

## Acceptance criteria

- [ ] `master-bootstrap-v1.txt` contains a `NOTIFICATIONS` section with the `[ORCHESTRATOR] TASK_COMPLETE` trigger format.
- [ ] Bootstrap instructs Claude to present exactly two choices: "1) Ignore for now" and "2) React immediately".
- [ ] Bootstrap instructs Claude to call `get_task(task_ref)` on option 2.
- [ ] Bootstrap contains a `FALLBACK CHECK` section with the `orc-master-check` command.
- [ ] The `[ORCHESTRATOR] TASK_COMPLETE` label in the bootstrap matches the label emitted by `masterPtyForwarder.mjs` exactly.
- [ ] `MASTER_BOOTSTRAP_END` is still present as the last line of the file.
- [ ] `READ STATE`, `WRITE STATE`, `RESOURCES`, `TYPICAL FLOW`, and `INVARIANTS` sections are unchanged.
- [ ] `nvm use 24 && npm test` passes (template is not compiled, but tests must not regress).

---

## Tests

No automated tests — bootstrap is a plain-text template.

Verify manually by reading the rendered output during `orc-start-session`:

```bash
orc-start-session --provider=claude
# Expected: bootstrap printed to terminal contains NOTIFICATIONS and FALLBACK CHECK sections
```

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
# Confirm template renders correctly
node -e "
  import { renderTemplate } from './lib/templateRender.mjs';
  console.log(renderTemplate('master-bootstrap-v1.txt', { agent_id: 'master', provider: 'claude' }));
" | grep -A5 'NOTIFICATIONS'
# Expected: section present and correctly formatted
```

---

## Risk / Rollback

**Risk:** None — plain-text template change with no stateful side effects.

**Rollback:** Revert `master-bootstrap-v1.txt` to the previous version. Running sessions are unaffected until the next `orc-start-session` invocation.
