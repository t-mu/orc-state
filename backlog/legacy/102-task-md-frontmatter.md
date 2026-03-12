---
ref: orch/task-102-task-md-frontmatter
epic: orch
status: done
---

# Task 102 — Add YAML Frontmatter to Task .md Template

Independent. Blocks Task 105.

## Scope

**In scope:**
- `.claude/skills/create-task/references/task-template.md` — add frontmatter block as the very first content
- `.claude/skills/create-task/SKILL.md` — update Step 0 to instruct populating frontmatter fields when writing a new .md

**Out of scope:**
- Backfilling frontmatter into existing `docs/backlog/*.md` files
- Changes to `backlog.json`, MCP handlers, or any orchestrator source files
- Adding any frontmatter fields beyond `ref` and `epic`

## Context

Task 105 (skill → MCP registration) needs to read the task ref from each .md file to decide whether to call `create_task` (new) or `update_task` (existing). Without a machine-readable `ref` field in the file, the only option is to infer the ref from the filename, which is fragile (the numeric prefix is not stored in `backlog.json` and the slug may not match exactly).

Adding YAML frontmatter with `ref` and `epic` fields solves this cleanly: any tool, agent, or script can locate a task's backlog record by grepping `docs/backlog/*.md` for `ref: <value>` without filename heuristics.

**Affected files:**
- `.claude/skills/create-task/references/task-template.md` — fill-in-the-blanks template used by agents to write new specs
- `.claude/skills/create-task/SKILL.md` — procedural instructions for the create-task skill agent

## Goals

1. Must add a YAML frontmatter block (`---` fences, `ref` and `epic` fields) as the first content in `task-template.md`, before the `# Task <N>` heading.
2. Must use placeholder values in the template that make the expected format unambiguous: `ref: <epic>/<slug>` and `epic: <epic-ref>`.
3. Must update SKILL.md Step 0 to instruct the agent to populate `ref` and `epic` in the frontmatter when writing a new .md file.
4. Must not alter any other section of SKILL.md or the template beyond the frontmatter addition and Step 0 instruction.

## Implementation

### Step 1 — Add frontmatter block to task template

**File:** `.claude/skills/create-task/references/task-template.md`

Insert before the existing `# Task <N>` first line:

```markdown
---
ref: <epic>/<slug>
epic: <epic-ref>
---

# Task <N> — <Imperative Title>
```

`<epic>/<slug>` follows the same pattern as backlog.json task refs (e.g. `orch/task-102-task-md-frontmatter`). `<slug>` is the kebab-case filename without the numeric prefix and `.md` extension.

### Step 2 — Update SKILL.md Step 0 to populate frontmatter

**File:** `.claude/skills/create-task/SKILL.md`

In the **Step 0 — Orient Before Drafting** section, append a fourth instruction after the existing three:

```markdown
4. **Populate frontmatter fields** before writing the file:
   - `ref`: `<epic>/<slug>` where `<slug>` is the kebab-case filename without the numeric prefix
     and `.md` extension (e.g. for `102-task-md-frontmatter.md` → `orch/task-102-task-md-frontmatter`
     — include the numeric prefix in the slug).
   - `epic`: the resolved epic ref (e.g. `orch`).
```

## Acceptance criteria

- [ ] `task-template.md` begins with a YAML frontmatter block (`---` … `---`) containing `ref` and `epic` placeholder fields.
- [ ] The frontmatter appears before the `# Task <N>` heading.
- [ ] SKILL.md Step 0 contains an instruction (step 4) that explicitly names both `ref` and `epic` and shows the expected format.
- [ ] No other sections of SKILL.md or task-template.md are modified.
- [ ] No changes to files outside the stated scope.

## Tests

No automated tests — this task modifies skill instruction text and a markdown template. Verification is manual: confirm the template and skill text match the acceptance criteria above by reading both files after the change.

## Verification

```bash
# Confirm frontmatter is present in template
head -5 .claude/skills/create-task/references/task-template.md
# Expected first line: ---

# Confirm Step 0 has 4 numbered items
grep -c '^\d\.' .claude/skills/create-task/SKILL.md || grep -c '^[0-9]\.' .claude/skills/create-task/SKILL.md
```
