# Dev Container

Bookworm-based development container with:

- Node 24
- `codex`
- `claude`
- `opencode`
- `gh`
- `bubblewrap`
- common dev tools (`git`, `ripgrep`, `sqlite3`, `tmux`, `ffmpeg`)

This image is for cloning the repo inside the container. It does not bake in the
repository or any auth state.

It uses the official image's built-in `node` user, so the container home is
`/home/node`.

The compose file uses a persistent Docker volume for `/home/node`, so Codex and
Claude auth/config live inside the container environment and survive restarts.
GitHub CLI auth is shared from the host via `~/.config/gh`.

On container startup, the devbox entrypoint writes `/home/node/.codex/config.toml`
with:

```toml
ask_for_approval = "never"
sandbox = "danger-full-access"

[features]
multi_agent = true
```

That keeps the aggressive Codex settings local to the container instead of your
host machine.

If `/home/node/workspace/orc-state` already exists, the entrypoint also ensures
the repo-local `.claude/settings.local.json` contains:

```json
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
```

If you clone the repo after the container is already running for the first time,
restart the container once so the entrypoint can apply the Claude settings merge.

## Build

```bash
docker compose -f docker/dev/docker-compose.yml build
```

## Start

```bash
docker compose -f docker/dev/docker-compose.yml up -d
docker exec -it devbox bash
```

If an older `devbox` container already exists, remove it first:

```bash
docker rm -f devbox
```

## Bootstrap inside the container

```bash
cd ~/workspace
git clone <repo-url> orc-state
cd orc-state
npm install
npm run link-local-all
```

## Log in

```bash
gh auth login
codex login
claude login
```

Those logins are stored inside the persistent `/home/node` Docker volume, so
you only need to do them once per devbox volume. `gh` reuses the host login
state through the mounted `~/.config/gh` directory.

## Codex config

`/home/node/.codex/config.toml` is created automatically by the entrypoint on
container startup.

In this Docker environment, the explicit CLI bypass flag is still needed to get
full access reliably. Use:

```bash
npm run codex
```
