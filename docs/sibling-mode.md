# Sibling Orchestration Mode (retired)

Sibling mode drove a product repository from a separate orchestration
repository: an orchestration home holding `orc-state.config.json` with
`target_repo`, `.orc-state/`, `backlog/` and `plans/`. A **registered project**
replaces it. The project's state, worktrees, settings, tasks and plans live in
an external data directory, and the target repository receives only product
commits. There is no orchestration repository to maintain, and no status is
mirrored into Markdown.

- Start a new project with `orc project add <target-repo-path>`. See
  [Configuration → Global project registry](./configuration.md#global-project-registry-new-project-api).
- Move an existing sibling home with `orc project migrate <orchestration-home>`.
  Without flags it is a dry run; `--execute` backs up, imports, verifies, and
  cuts over. See [Configuration → Migrating an existing installation](./configuration.md#migrating-an-existing-installation).

An unmigrated sibling home no longer runs. `orc start-session`, the
coordinator and the MCP server refuse it, and `orc doctor`/`orc preflight`
report it, so runs can never land in the orchestration home by mistake.
`orc init --sibling` is retired.
