# Orchestrator Backlog

This directory is the **authoritative task backlog** for orchestrator work.
Tasks are numbered sequentially and written as markdown spec files.

## Creating new tasks

1. Write the spec using `TASK_TEMPLATE.md` as the guide.
2. Register the task in the runtime dispatch queue with the
   MCP `create_task` tool so the coordinator can assign it to a worker.
3. After writing the spec and registering the task, run `orc backlog-sync-check`
   to confirm the spec and state are in sync.

Tasks in `legacy/` are historical specs from the original monorepo.
Tasks numbered 160+ are orchestrator-only work.

## Conventions for Implementors

- All new source files are `.mjs` (ES modules); use `import` not `require`; do not use TypeScript.
- Run `nvm use 24 && npm test` after each task to verify nothing regressed.
- Do not create new files unless a task explicitly asks for one.
- Do not add comments to code you did not change.
