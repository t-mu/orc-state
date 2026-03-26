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

## Build

```bash
docker compose -f docker/dev/docker-compose.yml build
```

## Start

```bash
docker compose -f docker/dev/docker-compose.yml up -d
docker exec -it devbox bash
```

## Bootstrap inside the container

```bash
cd ~/workspace
git clone <repo-url> orc-state
cd orc-state
npm install
bash scripts/link-local-skills.sh
bash scripts/link-local-agents.sh
```

## Log in

```bash
gh auth login
codex login
claude login
```

## Suggested Codex config

Use no approval prompts with the normal workspace sandbox:

```toml
ask_for_approval = "never"
sandbox = "workspace-write"
```

Put that in:

```bash
~/.codex/config.toml
```
