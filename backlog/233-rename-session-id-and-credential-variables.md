---
ref: global-project-state/233-rename-session-id-and-credential-variables
feature: global-project-state
review_level: light
priority: low
status: todo
depends_on:
  - global-project-state/231-authenticate-sessions-with-per-session-secrets
---

# Task 233 — Rename session id and credential variables

Depends on Task 231.

## Scope

**In scope:**
- Rename the worker environment variable `ORC_SESSION_TOKEN` (now only the session's identifier) to `ORC_SESSION_ID`, keeping `ORC_SESSION_TOKEN` as a legacy-only alias.
- Rename `ControlClient`'s `sessionToken` option to `credential`, since it carries a session secret.
- Update the bootstrap templates' `--session-token` wording for `report-for-duty` to match.

**Out of scope:**
- Changing how sessions authenticate (Task 231).

---

## Context

Task 231 made a per-session secret (`ORC_SESSION_SECRET`, `ORC_MASTER_SECRET`) the control API credential. The session id stayed in `ORC_SESSION_TOKEN`, so "token" now names an identifier and "secret" the credential, which invites using the wrong one.

### Current state

`ORC_SESSION_TOKEN` carries the session id; `ControlClient({ sessionToken })` carries a secret.

### Desired state

Names say what each value is: `ORC_SESSION_ID` for the identifier, `credential` for what a client presents.

### Start here

- `lib/workerRuntime.ts` (`normalizeWorkerEnv`), `lib/controlClient.ts`, `cli/control.ts`, `cli/run-input-respond.ts`, `templates/*bootstrap*.txt`.

**Affected files:** the files above, their tests, `docs/configuration.md`, `docs/cli.md`, `docs/contracts.md`.

---

## Acceptance criteria

- [ ] Workers receive `ORC_SESSION_ID`; `ORC_SESSION_TOKEN` is read only as a legacy alias.
- [ ] `ControlClient` takes `credential`; no caller passes a session id where a secret is expected.
- [ ] Docs and templates use the new names.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test && npm run test:e2e
```
