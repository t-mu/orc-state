---
ref: orch/task-140-update-master-bootstrap-input-request-handler
epic: orch
status: done
---

# Task 140 — Update Master Bootstrap Templates with INPUT_REQUEST Handler

Depends on Tasks 137 and 138.

## Scope

**In scope:**
- `templates/master-bootstrap-v1.txt` — add INPUT_REQUEST notification handler
- `templates/master-bootstrap-codex-v1.txt` — add INPUT_REQUEST notification handler
- `templates/master-bootstrap-gemini-v1.txt` — add INPUT_REQUEST notification handler

**Out of scope:**
- Any CLI, coordinator, MCP, schema, or worker bootstrap changes
- Changes to any other section of the master bootstrap templates
- Worker bootstrap — Task 139

---

## Context

Tasks 137 and 138 wire the coordinator to notify the master and give the master a tool to respond. This task adds the handling instructions to all three master bootstrap templates so that any provider running as master (Claude, Codex, Gemini) knows what to do when an `INPUT_REQUEST` notification arrives.

The handler block must mirror the existing `TASK_COMPLETE` handler in format and placement — the master already knows how to handle that pattern, so following the same structure minimises ambiguity.

**Affected files:**
- `templates/master-bootstrap-v1.txt` — Claude master bootstrap
- `templates/master-bootstrap-codex-v1.txt` — Codex master bootstrap
- `templates/master-bootstrap-gemini-v1.txt` — Gemini master bootstrap

---

## Goals

1. Must add an `INPUT_REQUEST` notification handler block to all three master bootstrap templates.
2. Must instruct the master to surface the question to the user and wait for their answer.
3. Must instruct the master to call `respond_to_input(run_id, response)` after receiving the user's answer.
4. Must follow the same format and placement as the existing `TASK_COMPLETE` handler in each template.
5. Must contain no provider-specific language — the block is identical across all three files.
6. Must not modify any other section of any bootstrap template.

---

## Implementation

### Step 1 — Add handler block to all three templates

**Files:**
- `templates/master-bootstrap-v1.txt`
- `templates/master-bootstrap-codex-v1.txt`
- `templates/master-bootstrap-gemini-v1.txt`

Add the following block immediately after the existing `TASK_COMPLETE` handler in each file:

```
NOTIFICATIONS — INPUT_REQUEST

When you receive an [ORCHESTRATOR] INPUT_REQUEST block, do the following:
1. Immediately show the user the question. Include the task ref, worker ID, and the question text.
2. Wait for the user's answer.
3. Call respond_to_input with the run_id and the user's answer:
     respond_to_input(run_id="<run_id>", response="<user answer>")
4. Confirm to the user that the response has been delivered to the worker.

The INPUT_REQUEST block format is:

[ORCHESTRATOR] INPUT_REQUEST
  Task:     <task_ref>
  Worker:   <agent_id>
  Run:      <run_id>
  Question: <question>
```

---

## Acceptance criteria

- [ ] All three master bootstrap templates contain an INPUT_REQUEST handler block.
- [ ] The handler instructs the master to show the question to the user and call `respond_to_input`.
- [ ] The block format matches the existing TASK_COMPLETE handler in style and placement.
- [ ] The block is identical across all three template files.
- [ ] No provider-specific language in any of the three blocks.
- [ ] No other section of any template is modified.
- [ ] No changes to files outside the stated scope.

---

## Tests

No automated tests — these are instructional text files. Verify manually that all three templates contain the handler block after editing.

---

## Verification

```bash
grep -c "INPUT_REQUEST" templates/master-bootstrap-v1.txt
grep -c "INPUT_REQUEST" templates/master-bootstrap-codex-v1.txt
grep -c "INPUT_REQUEST" templates/master-bootstrap-gemini-v1.txt
# Each should output at least 2 (header + body reference)
```
