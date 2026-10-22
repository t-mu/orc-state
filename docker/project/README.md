# Persistent project container

This runtime packages one Git project with a long-lived coordinator and a pool of
workers in one non-root container. The existing `docker/dev` shell is separate.

## Start

From the Git checkout you want agents to work in:

```bash
export ORC_PROJECT_DIR="$PWD"
/path/to/orc-state/docker/project/orc-project.sh build
/path/to/orc-state/docker/project/orc-project.sh login claude
/path/to/orc-state/docker/project/orc-project.sh up
/path/to/orc-state/docker/project/orc-project.sh master claude
```

The launcher builds the image with your host UID/GID, derives a stable Compose
project name from the checkout path, and mounts that checkout at
`/workspace/project`. Run `login codex` or `login gemini` as well when using those
providers. `login gh` is available for GitHub CLI operations. Credentials stay
in the Docker `project-home` volume for this checkout; the launcher never
mounts host home, SSH keys, GitHub config, or the Docker socket. Existing
provider environment credentials can be supplied through a project-specific
Compose override if needed; treat them as accessible to agents in the container.

The launcher starts the coordinator as the container's main process. `master`
waits for that coordinator and starts the interactive master as another process
via `docker compose exec`; `orc start-session` reuses the running coordinator.
workers are separate processes inside the same container. The default worker
capacity is two (`ORC_MAX_WORKERS=2`). Set `ORC_WORKER_PROVIDER` and
`ORC_MASTER_PROVIDER` if they differ from `orc-state.config.json`. The project
must have been initialized with `orc init` before starting a master session;
the container initializes missing runtime state without replacing existing
config or task specs.

Useful commands:

```bash
/path/to/orc-state/docker/project/orc-project.sh status
/path/to/orc-state/docker/project/orc-project.sh preflight
/path/to/orc-state/docker/project/orc-project.sh shell
/path/to/orc-state/docker/project/orc-project.sh down
```

`down` leaves the project, login and state volumes intact. Recreate with `up`.
Do not use `docker compose down --volumes` unless you intend to remove login
and SQLite state. Git worktrees remain under the project bind mount; SQLite and
control credentials remain in the nested `project-state` volume. An existing
host `.orc-state` directory is hidden while this container is running.

## Access and risk

The project checkout is a read/write bind mount. Agents in this container can
read and change every file in that checkout, including any secrets placed
there. Keep unrelated projects and secrets outside the mount. The container
has no host home or Docker socket mount, no published ports, no extra Linux
capabilities, and a read-only root filesystem. Its control API listens on a
Unix socket in the state volume, protected by a 0600 token. Host operators use
`orc-project.sh shell` or `docker compose exec` to run the CLI; Docker access
is the host authorization boundary. Nothing binds the control API to a LAN
interface.

The launcher checks the host Git checkout and uses your host UID/GID. Container preflight checks
UID, writable project/home/state and Git metadata, Node 24, required tools,
and selected provider login. After startup, run `orc doctor` inside `shell`
to inspect runtime health.

## Smoke test

Docker is required for the opt-in integration suite:

```bash
ORC_DOCKER_SMOKE=1 npm test -- docker/project/project.integration.test.ts
```

For a manual two-worker check, set `ORC_MAX_WORKERS=2`, provide two independent
ready tasks and authenticated worker provider sessions, then watch `orc status`
inside `shell` until two distinct workers show active runs. Stop and recreate
the container with `down` and `up`; verify both the run history and any
worktrees remain. This smoke uses real provider sessions and may consume their
usage allowance.
