# vNext provider and terminal protocol spike

Status: complete, 2026-10-17. This is an opt-in local experiment, not a
runtime integration. The host Docker experiment ran on the user's macOS host.
No token, API key, provider response text, or private transcript is recorded here.

## Environment and reproduction

The experiment ran in the Linux dev container (`Linux 6.12.76-linuxkit`,
`aarch64`, Node `v24.14.1`). Installed tools were Codex CLI `0.163.0`, Claude
Code `2.1.302`, and tmux `3.3a`. Docker CLI was unavailable inside the container
(`docker: command not found`). The coordinator was stopped before this spike.

The opt-in script prints event names and outcome fields only. It removes inherited
OpenAI/Anthropic API key and alternate provider routing variables from its child
processes so those settings cannot select metered inference for these runs. It
does not display their values. It uses each CLI's existing local login; it does
not initiate login or set up a new billing account.

```bash
# Run from this repository with an existing ChatGPT login in Codex CLI.
ORC_CODEX_SMOKE_BINARY=/home/node/.npm-global/bin/codex \
  node scripts/vnext-provider-smoke.ts codex

# Run only where Claude Code has a working subscription login.
ORC_CLAUDE_SMOKE_BINARY=/home/node/.local/bin/claude \
  node scripts/vnext-provider-smoke.ts claude
```

Both commands invoke real inference and are deliberately absent from `npm test`.
The binary overrides are local executable paths, not credentials. Their defaults
are `codex` and `claude` on `PATH`.

## Codex app-server

`codex login status` reported `Logged in using ChatGPT`. With API key settings
excluded from the child environment, the smoke opened `codex app-server
--listen stdio://`, sent `initialize`, then the `initialized` notification,
`thread/start`, and `turn/start`. The turn emitted `thread/started`,
`turn/started`, `item/started`, `item/agentMessage/delta`, `item/completed`, and
`turn/completed` with `turn.status = completed`. It took about four seconds.
The script discarded message content and stderr; it recorded only that stderr
was present.

A second app-server process successfully handled `thread/resume` using the ID
returned by the first process. This proves local thread lookup after server
replacement. A second inference turn after resume and recovery from an
interrupted turn were not exercised. The smoke uses `approvalPolicy: never` and
`sandbox: read-only`, so it does not prove interactive approval handling.

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server)
defines the initialization and thread/turn protocol, and its server-initiated
command and file-change approval requests. These request frames and their
responses still need an opt-in approval test before implementing an approval
bridge. A third-party app using [Sign in with ChatGPT token sharing](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
needs its own authorized OAuth flow; this local CLI-login result does not prove
that separate integration or its billing mode. The demonstrated local path is
the Codex CLI's ChatGPT login with app-server stdio.

## Claude structured output

`claude auth status` reported a `claude.ai` Team login. The smoke launched
`claude -p` with `--output-format stream-json --verbose`, an empty tools list,
and a generated session ID. The initial run received `system`, `assistant`,
and `result` frames with `subtype: success`, **but `is_error: true` and exit
code 1**. It was classified as an authentication failure without recording
the provider's error text.

After the Claude session became usable, the same command was rerun on
2026-10-17. Both the first turn and `--resume` emitted `system`, `assistant`,
`rate_limit_event`, and `result` frames. Both returned `subtype: success`,
`is_error: false`, and exit code 0. Stderr was present but discarded. The
script did not record either response text. This proves a successful
structured Claude CLI turn and session resume using the existing local login
with API key settings removed from the child environment. The `rate_limit_event`
frame is an observed event type; its payload and any limit value were not
examined. A live tool approval and resume after interruption remain untested.

The existing Claude CLI PTY adapter remains available while a structured
adapter is designed and reviewed. [Claude's subscription guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
describes Claude Code / Agent SDK access with plan limits. The CLI's Team
login and successful turn support the subscription path locally, though this
experiment cannot independently inspect provider-side billing records.

## Cross-process terminal attachment

The following was run with tmux `3.3a`. The first attach attempt without a
usable `TERM` failed with `open terminal failed: terminal does not support
clear`. With `TERM=xterm-256color`, a separate PTY process attached, appeared
in `list-clients` as `protocol-smoke /dev/pts/4`, detached with Ctrl-B,d, and
left the session alive with `attached=0 windows=1`. This proves that a tmux
server and its session survive the launcher and client process exits.

```bash
tmux -L orc-task195 new-session -d -s protocol-smoke 'sleep 180'
TERM=xterm-256color tmux -L orc-task195 attach-session -t protocol-smoke
tmux -L orc-task195 list-clients -F '#{session_name} #{client_tty}'
# In the attached PTY, press Ctrl-B then d.
tmux -L orc-task195 list-sessions -F '#{session_name} attached=#{session_attached} windows=#{session_windows}'
tmux -L orc-task195 kill-server
```

This does not prove resize, scrollback, read-only observers, or exclusive input
leases; those are terminal broker requirements for a later task.

## Host-to-container control transport

The dev container cannot reach Docker (`docker: command not found`; no
`/var/run/docker.sock`; the workspace is a Docker volume, not a host bind
mount), so the operator ran these checks on the actual host on 2026-10-17:
macOS `26.3`, Docker client and server `29.2.1` (Docker Desktop, Linux engine).
Each check used a disposable `node:24-alpine` container with no host home or
Docker socket mount. The server bound to the container interface (`0.0.0.0`);
the port was published only on host loopback.

**Loopback reachability and LAN exposure:**

```bash
docker run --rm --name orc-transport-smoke \
  -p 127.0.0.1:18765:8765 node:24-alpine \
  node -e 'require("http").createServer((_,r)=>r.end("ok")).listen(8765,"0.0.0.0")'
# Second host terminal:
curl --fail --silent http://127.0.0.1:18765/                                  # -> ok
curl --fail --silent --max-time 5 "http://$(ipconfig getifaddr en0):18765/"; echo "exit=$?"   # -> exit=7
```

The loopback request returned `ok`. The request to the host's LAN address was
refused (curl exit 7, connection refused), so a `127.0.0.1:` publish is not
reachable from the network.

**Bearer token rejection** (token generated per run, never recorded):

```bash
F=/tmp/orc-auth.js
echo "const t=process.env.ORC_TOKEN;" > $F
echo "const ok=(q)=>q.headers.authorization==='Bearer '+t;" >> $F
echo "require('http').createServer((q,r)=>{" >> $F
echo "if(ok(q))return r.end('ok');" >> $F
echo "r.statusCode=401;r.end('unauthorized');" >> $F
echo "}).listen(8766,'0.0.0.0');" >> $F
TOKEN=$(openssl rand -hex 16)
docker run -d --name orc-transport-auth \
  -e ORC_TOKEN="$TOKEN" -e SCRIPT="$(cat $F)" \
  -p 127.0.0.1:18766:8766 node:24-alpine \
  sh -c 'node -e "$SCRIPT"'
U=http://127.0.0.1:18766/
curl -s -o /dev/null -w 'missing: %{http_code}\n' $U                                   # -> 401
curl -s -o /dev/null -w 'wrong: %{http_code}\n' -H 'Authorization: Bearer wrong' $U    # -> 401
curl -s -o /dev/null -w 'correct: %{http_code}\n' -H "Authorization: Bearer $TOKEN" $U # -> 200
docker rm -f orc-transport-auth
```

Results: missing `401`, wrong `401`, correct `200`.

**Failure cases seen while running it.** Two earlier attempts returned `000` for
all three requests (connection failed): pasting a long one-line `node -e` script
wrapped a line inside a JavaScript string and made it a syntax error, and in a
heredoc variant the pasted terminal status text turned `SCRIPT=$(...)` into an
env prefix for a nonexistent command. In both cases the server exited at once
and `--rm` removed the container. Write the script to a file in short lines,
and check `docker ps` and `docker logs` before you read the curl results.

**Not tested:** a Unix socket bind-mounted from the container to the host.
Docker Desktop for Mac runs the engine in a VM and shares host files through a
file-sharing layer, so socket files in bind mounts cannot be relied on to
connect from the host; this alternative is rejected rather than proven broken.

## Decision and remaining gates

- **Codex:** subscription-backed structured path is app-server stdio under the
  CLI's ChatGPT login. Task 203 integrated it as the `structured` worker runtime
  (`adapters/codexAppServer.ts`; see `docs/configuration.md` → Worker Runtimes).
  Approval request handling and resume after an interrupted turn still need
  opt-in tests before an approval bridge is built; until then the runtime
  declines approvals and refuses steering and interrupt.
- **Claude:** subscription-backed structured path is `claude -p` stream-json
  under the CLI's Team login, including `--resume`. Live tool approval and resume
  after interruption are untested.
  Not yet integrated: a `structured` runtime request for Claude stays on the
  CLI and records the fallback reason.
- **Gemini:** not exercised; it stays on the existing CLI PTY adapter (explicit
  CLI fallback).
- **Terminal:** tmux cross-process attach/detach works with a usable `TERM`;
  resize, scrollback, observers and input leases belong to the terminal broker.
- **Host-to-container control transport:** authenticated loopback TCP. The
  project container publishes the daemon port as `127.0.0.1:<port>:<port>` and
  every request carries a bearer token. Inside the container, local clients
  keep the Unix socket from Task 201; adding the TCP listener is Task 206's
  packaging work, and that container needs its own published-port and token
  checks.
