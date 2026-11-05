# Persistent project container

One Git project, a long-lived coordinator and its workers in one non-root container. Separate from `docker/dev`.

## Start

From the Git checkout agents should work in (`L=/path/to/orc-state/docker/project/orc-project.sh`):

```bash
$L build
$L login claude            # also: login codex | gemini | gh
$L init claude             # once: orc project add + orc init (providers: claude,codex,...)
$L up                      # coordinator is the container's main process
$L master claude           # waits for the coordinator, then orc start-session
```

- `up` needs a registered, initialized project (`init`); the entrypoint (preflight → `project-init` → coordinator) exits otherwise. `init` is safe to re-run.
- Existing settings and tasks are never replaced; missing runtime state is initialized on start.
- `ORC_MAX_WORKERS` (default `2`), `ORC_WORKER_PROVIDER`, `ORC_MASTER_PROVIDER` override the registry settings.

| Command | Does |
|---------|------|
| `status` | `docker compose ps` |
| `preflight` | Container preflight (UID, writable mounts, Git metadata, Node 24, tools, provider login) |
| `shell` | Bash in the running container (run `orc doctor`, `orc status` here) |
| `down` | Stop; volumes are kept, recreate with `up` |

## Volumes

| Volume | Mount | Holds |
|--------|-------|-------|
| `project-home` | `/home/node` | Provider and `gh` logins |
| `project-state` | `/var/lib/orc-state` (`ORC_DATA_HOME`) | Registry, project state dir: SQLite state, run worktrees, control credentials |

The checkout is bind-mounted read/write at `/workspace/project`; only Git's worktree metadata lands in its `.git`. `docker compose down --volumes` deletes logins and state.

## Access and risk

- Agents can read and change every file in the checkout, including secrets there; keep unrelated projects and secrets out.
- No host home, SSH keys, `gh` config or Docker socket mount; no published ports; `cap_drop: ALL`; read-only root filesystem; runs with your host UID/GID.
- Control API: Unix socket in the state volume, 0600 token. Docker access is the host authorization boundary.
- Provider credentials passed through a Compose override are readable by agents.

## Smoke test

```bash
RUN_DOCKER_SMOKE=1 npm test -- docker/project/project.integration.test.ts
```

Manual two-worker check: `ORC_MAX_WORKERS=2`, two independent ready tasks, authenticated providers; watch `orc status` in `shell` for two active runs; `down` + `up` and confirm run history and worktrees remain. Uses real provider quota.
