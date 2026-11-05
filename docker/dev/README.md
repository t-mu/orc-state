# Dev Container

| | |
|---|---|
| Base | Debian bookworm, Node 24, user `node` (home `/home/node`) |
| Tools | `codex`, `claude`, `opencode`, `gh`, `bubblewrap`, `git`, `ripgrep`, `sqlite3`, `tmux`, `ffmpeg` |
| Persistence | Docker volume for `/home/node` (provider logins/config survive restarts); host `~/.config/gh` mounted for `gh` |
| Not baked in | The repository and any auth state; clone inside the container |

`NPM_CONFIG_PREFIX=/home/node/.npm-global` (its `bin` is on `PATH`).

## Entrypoint

On every start it:

- writes `/home/node/.codex/config.toml`:
  ```toml
  model = "gpt-5.4"
  model_reasoning_effort = "medium"
  ask_for_approval = "never"
  sandbox = "danger-full-access"

  [features]
  multi_agent = true
  ```
- merges `enabledMcpjsonServers: ["orchestrator"]`, `enableAllProjectMcpServers: true`, `permissions.defaultMode: "bypassPermissions"` and `skipDangerousModePermissionPrompt: true` into `~/.claude/settings.json` and, when `/home/node/workspace/orc-state` exists, into its `.claude/settings.local.json`;
- runs `npm link` in `/home/node/workspace/orc-state` when it exists.

Cloned the repo after the first start? Restart the container (or run the bootstrap below).

## Build and start

```bash
docker compose -f docker/dev/docker-compose.yml build
docker rm -f devbox    # only if an older devbox container exists
docker compose -f docker/dev/docker-compose.yml up -d
docker exec -it devbox bash
```

## Bootstrap inside the container

```bash
cd ~/workspace
git clone <repo-url> orc-state
cd orc-state
npm install
npm run build          # the orc bin is dist/cli/orc.js
npm run link-local-all
npm link
orc --help
```

## Log in (once per volume)

```bash
gh auth login
codex login
claude login
```

## Codex

Full access still needs the CLI bypass flag here: `npm run codex` (`codex --dangerously-bypass-approvals-and-sandbox`).
