---
ref: orch/task-105-create-task-skill-mcp-registration
epic: orch
status: done
---

# Task 105 — Skill Registers/Updates backlog.json After Each .md Write

Depends on Tasks 102, 103, 104.

## Scope

**In scope:**
- `.claude/skills/create-task/SKILL.md` — add MCP registration step at end of single-task and batch pipelines; add soft-fail warning behaviour; update batch workflow instructions

**Out of scope:**
- Changes to any orchestrator MCP server source files (`handlers.mjs`, `tools-list.mjs`, `server.mjs`)
- Changes to `task-template.md`
- Backfilling registration for existing unregistered .md files
- Any changes to `backlog.json` directly

## Context

After Tasks 102–104, the create-task skill knows the epic (Step 0.5) and writes frontmatter including `ref` (Task 102). The final missing piece is registration: after each .md is saved, the skill must sync the task record into `backlog.json` via MCP so the coordinator can dispatch it.

Without this step, every task written by the skill is invisible to the coordinator until manually registered — the desync problem that motivated this workstream.

The registration step uses `mcp__orchestrator__get_task` to distinguish create vs update, ensuring the skill is safe to run on both new and existing tasks:

- **New task** (get_task returns `{ error: "not_found" }`): call `mcp__orchestrator__create_task`
- **Existing task**: call `mcp__orchestrator__update_task` with changed fields

On MCP failure the skill must not abort — the .md is the durable artifact. Instead it emits a warning and offers to retry.

In batch mode, registration fires per-task immediately after each .md is written, not at the end of the batch. This matches the user's intent: "a task can be added when it has all necessary content."

**Affected files:**
- `.claude/skills/create-task/SKILL.md` — skill procedure instructions

## Goals

1. Must add a registration step that fires after each .md file is saved (single and batch).
2. Must read the `ref` value from the saved file's YAML frontmatter.
3. Must call `mcp__orchestrator__get_task` to determine create vs update.
4. Must call `mcp__orchestrator__create_task` for new tasks, passing `title`, `epic`, `description` (first paragraph of the Context section), and the ref slug.
5. Must call `mcp__orchestrator__update_task` for existing tasks, passing any fields that differ.
6. Must emit a visible warning block (not an error) if the MCP call fails, listing the unregistered `ref` and offering to register immediately.
7. Must run registration per-task in batch mode, not at the end of the batch.

## Implementation

### Step 1 — Add registration step to SKILL.md

**File:** `.claude/skills/create-task/SKILL.md`

Append a new section **"## Step: Register in backlog.json"** after the Single-Task Workflow section and before the Batch Workflow section:

```markdown
## Step: Register in backlog.json

After saving each .md file, perform MCP registration immediately:

### 1. Read the ref from frontmatter

The saved file begins with:
```yaml
---
ref: <epic>/<slug>
epic: <epic-ref>
---
```
Extract the `ref` value.

### 2. Check if already registered

Call `mcp__orchestrator__get_task` with `task_ref: <ref>`.

- If the result contains `{ "error": "not_found" }` → **create path**
- Otherwise → **update path**

### 3a. Create path

Call `mcp__orchestrator__create_task` with:
- `title`: the task title from the `# Task N — Title` heading
- `epic`: the `epic` frontmatter value
- `ref`: the slug portion only (everything after the first `/` in the frontmatter ref)
- `description`: the first non-empty paragraph of the `## Context` section
- `acceptance_criteria`: native JSON array extracted from the `## Acceptance criteria` checklist items (strip the `- [ ] ` prefix from each line)

### 3b. Update path

Call `mcp__orchestrator__update_task` with `task_ref: <ref>` and any fields that have changed: `title`, `description`, `acceptance_criteria`.

### 4. Handle failure (soft-fail)

If the MCP call throws or returns an error, **do not abort**. Instead emit:

```
⚠️  Registration warning
Task spec saved:  docs/backlog/<filename>.md
Backlog sync:     FAILED — <error message>
Ref:              <ref>

To register now, say: "register <ref>"
```

Continue to the next task in a batch without interruption.
```

### Step 2 — Update Batch Workflow instructions

**File:** `.claude/skills/create-task/SKILL.md`

In the **Batch Workflow** section, update step 5 to reference per-task registration:

```markdown
// Before:
5. Emit one complete task file per task using the same fixed section order.

// After:
5. Emit one complete task file per task using the same fixed section order,
   then immediately run the "Register in backlog.json" step for that task
   before moving to the next one.
```

## Acceptance criteria

- [ ] SKILL.md contains a "Register in backlog.json" section with sub-steps for read, check, create, update, and soft-fail.
- [ ] The create path instructs passing `title`, `epic`, `ref` slug, `description`, and `acceptance_criteria` to `mcp__orchestrator__create_task`.
- [ ] The update path instructs calling `mcp__orchestrator__update_task` with changed fields.
- [ ] The soft-fail path emits a formatted warning block and does not abort the skill.
- [ ] The warning block includes the unregistered `ref` and offers a recovery instruction.
- [ ] The Batch Workflow step 5 instructs running registration per-task immediately after each .md is saved.
- [ ] No changes to files outside the stated scope.

## Tests

No automated tests — this task modifies skill instruction text only. Verify by reading SKILL.md and confirming all acceptance criteria items are present.

## Verification

```bash
grep -c 'Register in backlog' .claude/skills/create-task/SKILL.md
# Expected: 2 (section heading + batch workflow reference)

grep 'mcp__orchestrator__get_task' .claude/skills/create-task/SKILL.md
# Expected: at least 1 match

grep 'soft-fail\|Registration warning\|FAILED' .claude/skills/create-task/SKILL.md
# Expected: at least 1 match
```
