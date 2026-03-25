---
ref: general/43-adapter-output-tail-interface
title: "43 Adapter Output Tail Interface"
status: todo
feature: general
task_type: implementation
priority: high
---

## Context

The coordinator needs to read the last N bytes of a worker's PTY output to
surface it in escalation notifications (task 45). Currently the PTY log path
is known only to `adapters/pty.ts`. Reading it directly from coordinator code
would couple coordinator to the PTY adapter and break silently when the tmux
adapter ships (tasks 6–13).

This task adds a `getOutputTail(sessionHandle): string | null` method to the
adapter interface so the coordinator can retrieve output tails in an
adapter-agnostic way.

## Acceptance Criteria

1. `AdapterInterface` in `adapters/interface.ts` declares
   `getOutputTail(sessionHandle: string): string | null`.
2. PTY adapter (`adapters/pty.ts`) implements it: reads last 8 KB of
   `pty-logs/<agentId>.log` using the existing `readLogTail` helper, strips
   ANSI using `stripAnsi` from `lib/masterPtyForwarder.ts`, returns the
   cleaned string (or `''` if the file does not exist).
3. Any stub/mock adapters used in tests implement `getOutputTail` returning
   `null`.
4. No coordinator or CLI code reads `pty-logs/` directly after this change.
5. All existing tests pass.

## Implementation Notes

- The existing `readLogTail(agentId)` in `adapters/pty.ts` (line 113) already
  reads the last `OUTPUT_TAIL_BYTES` bytes. Reuse it.
- `stripAnsi` already exists in `lib/masterPtyForwarder.ts` (line 56).
  Import and apply it before returning.
- The return value should be trimmed of leading/trailing blank lines to keep
  the notification readable.

## Files to Change

- `adapters/interface.ts`
- `adapters/pty.ts`
- Any test adapter stubs / mocks that implement the interface

## Verification

```bash
npm test
```
