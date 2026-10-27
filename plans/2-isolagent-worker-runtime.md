---
plan_id: 2
name: isolagent-worker-runtime
title: Isolagent Worker Runtime and Peer Messaging Before Desktop
created_at: 2026-10-24T00:00:00Z
updated_at: 2026-10-24T00:00:00Z
derived_task_refs:
  - isolagent-worker-runtime/210-specify-and-prove-the-isolated-runtime-boundary
  - isolagent-worker-runtime/211-add-a-headless-reconnectable-isolagent-supervisor-interface
  - isolagent-worker-runtime/212-package-isolated-worker-flavors-and-fail-closed-preflight
  - isolagent-worker-runtime/213-expose-the-scoped-worker-bridge-over-the-host-tunnel
  - isolagent-worker-runtime/214-integrate-isolagent-as-a-recoverable-worker-transport
  - isolagent-worker-runtime/215-connect-vm-worker-inboxes-to-durable-messages
  - isolagent-worker-runtime/216-connect-isolated-terminals-shells-and-operator-controls-to-cli-tui
  - isolagent-worker-runtime/217-prove-the-cli-tui-isolation-gate-and-block-desktop-until-it-passes
---

# Isolagent Worker Runtime and Peer Messaging Before Desktop

**Cancelled in this repository (2026-10-27):** The user decided to keep orc-state as a shareable base framework. Isolagent integration and the desktop client belong in a separate private repository that depends on a pinned orc-state release. Derived tasks 210–217 and desktop task 208 are cancelled here; this plan remains historical design context. The public framework may expose provider-neutral, authenticated project and worker APIs without depending on Isolagent.

## Objective

Run orc-state task workers in separate isolagent microVMs while keeping scheduling, state, Git finalization, and agent message routing in the host daemon. Preserve a complete CLI/TUI workflow and require a proven isolated workflow before desktop development begins.

## Scope

- Define the host daemon, per-run microVM, worktree, provider session, and recovery ownership contract for attached and sibling repository layouts.
- Add a headless, reconnectable isolagent supervisor interface in the isolagent repository and a compatible orc-state adapter.
- Package and validate VM flavors for each provider enabled in isolated mode; reject unsupported combinations before claiming work.
- Expose run-scoped lifecycle and message APIs to VM workers over an authenticated guest-to-host tunnel.
- Complete durable peer, review, and human message routing in existing Task 207, then connect VM worker inboxes to it.
- Connect isolated provider sessions and independent worktree shells to the existing terminal broker and CLI/TUI.
- Prove two concurrent isolated workers, messaging, recovery, finalization, and CLI/TUI operation without the desktop client.
- Add the isolagent completion gate to the existing desktop Task 208 while preserving its other dependencies.

## Out of Scope

- Building the Electron desktop client itself.
- Replacing the existing project container work in Task 206; it remains a separate deployment path.
- Direct VM-to-VM networking, a separate shared network proxy, or shared writable inbox directories.
- Silent fallback from requested isolation to an unsandboxed host provider process.
- Shipping new provider flavors without a real login, egress, and task lifecycle smoke test.

## Constraints

- The host daemon alone owns operational SQLite state, task scheduling, merges, and branch cleanup. A VM receives its assigned worktree as `/work` and only the additional mounts strictly required for Git.
- The default CLI/TUI workflow remains fully usable with the desktop client closed or absent; the desktop uses the same daemon API later.
- The current broad control token and public session IDs must not be exposed as VM authorization. Each worker receives a distinct revocable credential bound to its agent and active run.
- Guest-to-host access uses an explicitly permitted isolagent loopback tunnel. Worker APIs must reject cross-run, stale, and privileged operator requests.
- Attached and sibling repository layouts, daemon restart, host sleep, worker exit, and idempotent message delivery must be covered.
- The isolagent upstream implementation is performed and reviewed in the isolagent repository; the orc-state worktree never imports its source into this repository.
- Existing Task 206 is not rewritten while its project container branch is in progress. Task 208 retains its existing prerequisites and gains the isolated workflow gate.
- Node 24, Vitest, exact pinned npm dependencies, full `npm test`, and repository worktree/commit rules remain in force. Do not add npm dependencies without user authorization.

## Affected Areas

- `docs/vnext-architecture.md`, `docs/configuration.md`, `docs/testing.md` — runtime choice, trust boundary, platform prerequisites, and smoke procedure.
- `backlog/207-route-peer-review-and-human-messages.md`, `backlog/208-build-desktop-client-after-control-gates.md` — peer messaging and desktop prerequisite updates.
- `adapters/interface.ts`, `adapters/index.ts`, new isolagent adapter — VM session transport, capability reporting, output, probe, and recovery.
- `lib/workerRuntime.ts`, `lib/sessionSupervisor.ts`, `lib/providers.ts` — worktree launch, persisted VM identity, provider/flavor and platform preflight.
- `lib/controlServer.ts`, `lib/controlClient.ts`, `lib/controlProtocol.ts`, `lib/commandDelivery.ts` — guest API, scoped credentials, and durable messages.
- `lib/terminalBroker.ts`, CLI/TUI commands, and related tests — remote terminal, shell, attach, and operator controls.
- Upstream `isolagent` CLI, supervisor, guest session protocol, flavor examples, and tests — headless VM control.

## Implementation Steps

### Step 1 — Specify and prove the isolated runtime boundary

Document the exact host/guest ownership and filesystem contract in `docs/vnext-architecture.md`. Add a reproducible opt-in proof that boots two isolagent VMs against distinct Git worktrees, tests commit and rebase with the required Git mount, reaches one host loopback port through a configured tunnel, and records macOS and Linux/KVM prerequisites. Verify that a VM cannot read the orchestration state directory or host credentials. Keep Task 206's in-progress container implementation separate and explain that a macOS Linux container cannot directly host Apple Virtualization.framework guests. This step produces the tested mount and transport contract consumed by later tasks.

### Step 2 — Add a headless reconnectable isolagent supervisor interface

In the separate isolagent repository, implement a noninteractive control interface that starts a named per-worktree VM and a specified guest command, returns durable instance and session identifiers, streams output, sends input and terminal resize, reports liveness and ownership, reconnects from a second host process, and stops only the requested instance. Preserve existing interactive `run` and `exec` behavior. Add tests for missing image, failed guest command, supervisor exit, reconnect, and name collisions. Publish a versioned CLI/protocol contract and a real macOS or Linux VM smoke result before orc-state depends on it. Track this as an external-repository prerequisite rather than attempting to edit isolagent from an orc-state worker worktree.

Depends on: 1

### Step 3 — Package isolated worker flavors and fail-closed preflight

Provide a reproducible flavor image with Node 24, Git, the `orc` CLI, and a verified Claude CLI login path. Add explicit provider-to-flavor mapping and host capability checks in `lib/providers.ts` and preflight. Validate Codex and Gemini flavors separately before enabling them; the requested isolated provider must be rejected with a clear reason if its image, credentials, platform support, or egress rules are unavailable. Do not silently launch that worker on the host. Test Git worktree command execution and the host-controlled approval path for changed `.isolagent.toml` settings.

Depends on: 1, 2

### Step 4 — Expose the scoped worker bridge over the host tunnel

Add an authenticated loopback TCP endpoint to the daemon, reachable only through one explicitly configured isolagent guest-to-host tunnel port. Issue a random per-run worker credential at launch; bind it to agent ID, run ID, expiry, and revocation on terminal run state. Implement the minimum lifecycle, message, and read endpoints required by the guest `orc` client, without mounting `.orc-state` into VMs or forwarding the daemon's operator token. Reject cross-run mutation, forged sender fields, expired credentials, and operator-only methods. Test connected and disconnected behavior, including daemon restart.

Depends on: 1

### Step 5 — Integrate isolagent as a recoverable worker transport

Add an isolagent transport to `adapters/index.ts` and `lib/workerRuntime.ts` with start, send, output tail, attach, probe, stop, and session inspection. Persist VM instance identity separately from provider session and run IDs. Reconcile live VM/guest process state after daemon restart, host sleep, and stale supervisor metadata; preserve healthy workers and mark uncertain ownership recoverable rather than redispatching. Support attached and sibling layouts, and leave the existing host PTY, tmux, structured, and project-container paths intact. Test two concurrent worktrees and failure cleanup.

Depends on: 2, 3, 4

### Step 6 — Connect VM worker inboxes to durable messages

Consume the durable typed peer and human messages supplied by existing Task 207 through the scoped worker bridge. Add worker inbox reads or long polling and consumption acknowledgements for a VM worker, so no inbound VM port or direct VM-to-VM proxy is needed. Deliver a peer review request from one isolated run to a second isolated run and bind its result to the initiating request. Reject cross-run reads, stale credentials, and duplicate consumption after reconnect. This task integrates the existing message store; it does not create a second message schema or router. Its backlog spec must explicitly depend on existing Task 207 in addition to the generated plan dependencies.

Depends on: 4, 5

### Step 7 — Connect isolated terminals, shells, and operator controls to CLI/TUI

Bridge isolagent's output, input, resize, and reconnect capabilities into `lib/terminalBroker.ts`; preserve read-only observers and exclusive writer leases. Open a separate `/work` shell without stealing the provider terminal. Surface approval requests, egress denials, and VM failures through the daemon and existing CLI/TUI controls. Verify attach/detach, two-writer contention, CLI/TUI restart, and continued worker execution with the TUI closed.

Depends on: 5, 6

### Step 8 — Prove the CLI/TUI isolation gate and block desktop until it passes

Add an opt-in end-to-end test that uses only CLI/TUI and the daemon to run two concurrent isolated workers, exchange a peer review and human reply, restart the daemon, recover both VM sessions, open an independent shell, and finalize Git worktrees. Run the proof on supported macOS and Linux hosts, with a documented provider/flavor matrix and failure evidence. Existing Task 208 must already depend on this gate in its frontmatter before any integration work starts; this step proves the gate can be marked done. The desktop client remains optional.

Depends on: 6, 7
