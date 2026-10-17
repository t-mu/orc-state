# vNext provider and terminal protocol spike

Status: partial evidence, 2026-10-17. This is an opt-in local experiment, not a
runtime integration. The host Docker experiment remains open.
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

This agent ran inside the existing `devbox` container. Its
`docker/dev/docker-compose.yml` service publishes no ports, and this container
has no Docker CLI or host daemon access. A server started here alone cannot
prove that a request from the host reaches a host-loopback published port.
No claim about host-loopback reachability, socket bind behavior, or
authentication is possible from this environment. The transport choice
remains open.

On the actual host, run a disposable container without mounting host home or
the Docker socket. This probes the host's Docker port-publishing behavior; it
does not test the current `devbox` container or a future project container.
Use a free host port and stop the container after testing. The server must bind
to the container interface (`0.0.0.0`); the published port binds only to host loopback.
Confirm a host request succeeds and that a request to the host's non-loopback
address fails before choosing TCP. Then repeat with a scoped authentication
token and verify missing/wrong tokens are rejected. A Unix socket needs a
separate bind-mount and host permission test before it can be selected instead.

```bash
docker run --rm --name orc-transport-smoke \
  -p 127.0.0.1:18765:8765 node:24-alpine \
  node -e 'require("http").createServer((_,r)=>r.end("ok")).listen(8765,"0.0.0.0")'
# In a second host terminal:
curl --fail --silent http://127.0.0.1:18765/
```

The example only tests connectivity. It is not an authenticated control
server, and it must not be used as the final API design. The final project
container needs its own published-port and authentication checks on the host.
Unix socket versus authenticated loopback TCP cannot be decided until the
actual host experiment and rejection tests are recorded.

## Decision and remaining gates

Codex app-server stdio is a viable local structured candidate under the CLI's
ChatGPT login. Claude structured output passed a local turn and resume using
the CLI's Team login. tmux passed a basic cross-process attach/detach test
with a suitable terminal type. Defer the host transport selection and Task
195 completion until the actual-host Docker test is recorded.
