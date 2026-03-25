---
ref: general/46-notification-guidance-and-bootstrap
title: "46 Notification Guidance And Bootstrap"
status: blocked
feature: general
task_type: implementation
priority: normal
depends_on:
  - general/45-coordinator-worker-stale-escalation
---

## Context

With bypass permissions enabled, `orc run-input-request` is no longer needed
for tool permission prompts. Workers should only use it for genuine human
decision points. Additionally, the master bootstrap needs instructions for
handling the new `WORKER_NEEDS_ATTENTION` notification type introduced in
task 45.

## Acceptance Criteria

1. `AGENTS.md` updated: `orc run-input-request` section clarified — only call
   it for:
   - Ambiguous or missing spec requirements that block implementation
   - Merge conflicts that are genuinely unresolvable
   - External dependencies unavailable (service down, credential missing)
   — explicitly NOT for tool permissions (bypass handles those).
2. `templates/master-bootstrap-v1.txt` gains a `WORKER_NEEDS_ATTENTION`
   handler block in the NOTIFICATIONS section, describing:
   - What the notification means (worker idle past escalation threshold)
   - Fields available: `agent_id`, `task_ref`, `idle_ms`, `pty_tail`
   - Recommended actions to surface to user: wait / force-fail the run /
     intervene directly
3. `templates/master-bootstrap-codex-v1.txt` and
   `templates/master-bootstrap-gemini-v1.txt` receive the same handler block
   for consistency.
4. All three template files compile (no broken template syntax) and
   `orc doctor` exits 0.

## Files to Change

- `AGENTS.md`
- `templates/master-bootstrap-v1.txt`
- `templates/master-bootstrap-codex-v1.txt`
- `templates/master-bootstrap-gemini-v1.txt`

## Verification

```bash
orc doctor
npm test
```
