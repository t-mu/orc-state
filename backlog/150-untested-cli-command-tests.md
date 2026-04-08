---
ref: general/150-untested-cli-command-tests
feature: general
priority: normal
status: todo
---

# Task 150 — Add Tests for Untested Worker Lifecycle CLI Commands

Independent.

## Scope

**In scope:**
- Add co-located `.test.ts` files for 21 CLI commands that currently lack tests
- Follow existing test patterns: temp dir with mock state, call command, assert stdout/stderr/exit code and state mutations

**Out of scope:**
- Modifying the CLI commands themselves (test existing behavior only)
- E2E or integration tests (those belong in `e2e/`)
- Increasing coverage of already-tested CLI commands
- Refactoring test infrastructure or shared test helpers

---

## Context

98 test files exist for 139 source files (~70% coverage), but 21 CLI commands
have zero tests. These are the commands workers call most frequently — the
critical lifecycle path is entirely untested at the unit level.

The commands are organized in four tiers by consumer impact:

**Tier 1 — Critical path (every worker calls these):**
`run-start`, `run-work-complete`, `run-finish`, `run-fail`, `run-heartbeat`

**Tier 2 — Input flow:**
`run-input-request`, `run-input-respond`, `waiting-input`

**Tier 3 — Status/query:**
`run-info`, `run-expire`, `worker-status`, `backlog-blocked`, `backlog-ready`, `backlog-orient`

**Tier 4 — Remaining:**
`events-filter`, `task-unblock`, `task-reset`, `report-for-duty`, `feature-create`, `mcp-server`, `shared`

Existing test patterns (e.g., `cli/delegate-task.test.ts`, `cli/init.test.ts`)
use temp directories with seeded state files, spawn the command via
`execFileSync` or import the module, and assert on outputs and state mutations.

**Affected files:**
- `cli/run-start.test.ts` — new
- `cli/run-work-complete.test.ts` — new
- `cli/run-finish.test.ts` — new
- `cli/run-fail.test.ts` — new
- `cli/run-heartbeat.test.ts` — new
- `cli/run-input-request.test.ts` — new
- `cli/run-input-respond.test.ts` — new
- `cli/waiting-input.test.ts` — new
- `cli/run-info.test.ts` — new
- `cli/run-expire.test.ts` — new
- `cli/worker-status.test.ts` — new
- `cli/backlog-blocked.test.ts` — new
- `cli/backlog-ready.test.ts` — new
- `cli/backlog-orient.test.ts` — new
- `cli/events-filter.test.ts` — new
- `cli/task-unblock.test.ts` — new
- `cli/task-reset.test.ts` — new
- `cli/report-for-duty.test.ts` — new
- `cli/feature-create.test.ts` — new
- `cli/mcp-server.test.ts` — new
- `cli/shared.test.ts` — new

---

## Goals

1. Must add test files for all 21 untested CLI commands.
2. Must include at least one happy-path and one error-path test per command.
3. Must follow existing co-located test patterns (`cli/foo.test.ts` next to `cli/foo.ts`).
4. Must use temp directories with mock state files (not real `.orc-state/`).
5. Must not modify any source files — test existing behavior only.

---

## Implementation

### Step 1 — Tier 1: Worker lifecycle commands

**Files:** `cli/run-start.test.ts`, `cli/run-work-complete.test.ts`, `cli/run-finish.test.ts`, `cli/run-fail.test.ts`, `cli/run-heartbeat.test.ts`

For each command:
1. Set up temp dir with valid `backlog.json`, `agents.json`, `claims.json`, `events.db`
2. Seed a claim in `claimed` or `in_progress` state as appropriate
3. Run the command with `--run-id` and `--agent-id` flags
4. Assert: correct exit code, claim state transition, event emitted
5. Error case: run with invalid/missing run-id, assert exit 1 with descriptive message

### Step 2 — Tier 2: Input flow commands

**Files:** `cli/run-input-request.test.ts`, `cli/run-input-respond.test.ts`, `cli/waiting-input.test.ts`

- `run-input-request`: seed an in_progress claim, call with `--question`, assert claim gets `input_requested` state
- `run-input-respond`: seed claim with pending input, call with `--response`, assert input is delivered
- `waiting-input`: seed claims with and without pending input, assert correct filtering in output

### Step 3 — Tier 3: Status/query commands

**Files:** `cli/run-info.test.ts`, `cli/run-expire.test.ts`, `cli/worker-status.test.ts`, `cli/backlog-blocked.test.ts`, `cli/backlog-ready.test.ts`, `cli/backlog-orient.test.ts`

Each command reads state and produces output. Seed state files, run command, assert stdout contains expected data. Error case: missing state file or empty state.

### Step 4 — Tier 4: Remaining commands

**Files:** `cli/events-filter.test.ts`, `cli/task-unblock.test.ts`, `cli/task-reset.test.ts`, `cli/report-for-duty.test.ts`, `cli/feature-create.test.ts`, `cli/mcp-server.test.ts`, `cli/shared.test.ts`

Follow same pattern. `shared.test.ts` tests exported utility functions (`cliError`, flag parsing helpers).

---

## Acceptance criteria

- [ ] All 5 Tier 1 commands have test files with happy-path and error-path tests.
- [ ] All 3 Tier 2 commands have test files.
- [ ] All 6 Tier 3 commands have test files.
- [ ] All 7 Tier 4 commands have test files.
- [ ] Tests use temp directories with mock state (not real `.orc-state/`).
- [ ] Tests are co-located (`cli/foo.test.ts` next to `cli/foo.ts`).
- [ ] No source files modified — tests cover existing behavior only.
- [ ] `npm test` passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

This task is entirely about writing tests. Each of the 21 new test files
should contain at minimum:

```typescript
describe('orc <command>', () => {
  it('succeeds with valid state and arguments', () => { ... });
  it('exits 1 with descriptive error when <failure condition>', () => { ... });
});
```

---

## Verification

```bash
nvm use 24 && npm test
```
