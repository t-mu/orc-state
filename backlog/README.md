# Orchestrator Backlog

This repository is a registered project: its tasks live in the project's
SQLite store, and the specs here are the historical record from before the
migration. Nothing reads them at runtime, and task status is runtime-owned.

## Creating new tasks

1. Write the body using `../docs/task-template.md` as the guide.
2. Create the task with `orc project task create --body-file=<file>`,
   `orc project task import <file>`, or the MCP `create_task` tool
   (`body_markdown`). No file needs to be added here.

Tasks in `legacy/` are historical specs from the original monorepo.
Tasks numbered 160+ are orchestrator-only work.

## Conventions for Implementors

- All new source files in this repository are TypeScript `.ts` ES modules; use `import`, not `require`.
- Run `nvm use 24 && npm test` after each task to verify nothing regressed.
- Do not create new files unless a task explicitly asks for one.
- Do not add comments to code you did not change.
