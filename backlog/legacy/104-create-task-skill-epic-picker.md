---
ref: orch/task-104-create-task-skill-epic-picker
epic: orch
status: done
---

# Task 104 — Add Epic Picker to create-task Skill

Depends on Task 103. Blocks Task 105.

## Scope

**In scope:**
- `.claude/skills/create-task/SKILL.md` — add epic resolution step before .md writing

**Out of scope:**
- Changes to `tools-list.mjs`, `handlers.mjs`, or any MCP server files
- Changes to `task-template.md`
- Creating or modifying epics in `backlog.json` directly (delegated to `create_task` MCP)

## Context

Currently the create-task skill has no guidance on how to determine the epic for a new task. The agent either guesses from context or omits it entirely. After Task 103 lands, omitting epic defaults to `"general"` — but the agent should make an informed choice rather than silently defaulting.

The fix is an explicit resolution step at the very start of the skill workflow: infer from context when possible, otherwise ask the user via `AskUserQuestion` with a numbered list of existing epics and an "Add new" escape hatch.

**Affected files:**
- `.claude/skills/create-task/SKILL.md` — skill procedure instructions

## Goals

1. Must resolve the epic before writing any .md file.
2. Must infer the epic from the user's request when it is unambiguous (e.g. "create an orch task for X" → `orch`).
3. Must use `ReadMcpResourceTool` on `orchestrator://state/backlog` to retrieve the list of existing epics when inference is not possible.
4. Must present a numbered list of existing epic refs plus an "x. Add new epic" option via `AskUserQuestion`.
5. Must follow up with a second `AskUserQuestion` for the epic name when the user selects "Add new".
6. Must pass the resolved epic into all subsequent .md writing steps and into the frontmatter `epic` field.

## Implementation

### Step 1 — Add epic resolution section to SKILL.md

**File:** `.claude/skills/create-task/SKILL.md`

Insert a new section **"## Step 0.5 — Resolve Epic"** between Step 0 and the existing "Required Inputs" section:

```markdown
## Step 0.5 — Resolve Epic

Before writing any file, determine the epic for this task:

1. **Infer from context.** If the user's request unambiguously names an epic
   (e.g. "create an orch task", "add this to the infra epic"), use that value directly.
   Skip steps 2–4.

2. **Read existing epics.** Use `ReadMcpResourceTool` with URI
   `orchestrator://state/backlog` and extract the `ref` field from each entry
   in the `epics` array.

3. **Ask the user.** Use `AskUserQuestion` with a message such as:

   ```
   Which epic should this task belong to?
   1. orch
   2. general
   3. infra
   x. Add new epic
   ```

   Present only the refs, one per line, numbered from 1. Always append `x. Add new epic` as the last option.

4. **Handle "Add new".** If the user selects `x`, use a second `AskUserQuestion`:

   ```
   Enter the new epic name (lowercase, hyphen-separated, e.g. "my-feature"):
   ```

   Use the entered value as the epic ref. The `create_task` MCP call will create the
   epic if it does not yet exist (Task 103 behaviour — only works for "general" automatically;
   for any other new epic name the agent must note it may not exist and the MCP call may fail).

5. **Store the resolved epic** and use it for:
   - The `epic:` frontmatter field in every .md file written during this skill invocation
   - The `epic` argument to `mcp__orchestrator__create_task` (Task 105)
```

## Acceptance criteria

- [ ] SKILL.md contains a Step 0.5 section between Step 0 and the Required Inputs section.
- [ ] Step 0.5 instructs the agent to infer the epic from context before prompting.
- [ ] Step 0.5 instructs the agent to call `ReadMcpResourceTool` on `orchestrator://state/backlog` to get existing epics.
- [ ] Step 0.5 instructs use of `AskUserQuestion` with a numbered list including `x. Add new epic`.
- [ ] Step 0.5 instructs a second `AskUserQuestion` for the epic name when "Add new" is chosen.
- [ ] Step 0.5 instructs storing the resolved epic for use in frontmatter and MCP calls.
- [ ] No changes to files outside the stated scope.

## Tests

No automated tests — this task modifies skill instruction text only. Verify by reading SKILL.md and confirming all acceptance criteria items are present in Step 0.5.

## Verification

```bash
grep -A 40 'Step 0.5' .claude/skills/create-task/SKILL.md
# Expected: section present with ReadMcpResourceTool, AskUserQuestion, and "Add new epic" instructions
```
