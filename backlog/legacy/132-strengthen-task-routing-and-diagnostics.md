---
ref: orch/task-132-strengthen-task-routing-and-diagnostics
epic: orch
status: done
---

# Task 132 — Strengthen Task Routing and Diagnostics

Independent. Blocks Task 133.

## Scope

**In scope:**
- `lib/taskRouting.mjs` — replace shallow boolean checks with explicit eligibility evaluation and reasons
- `lib/dispatchPlanner.mjs` — surface routing failures more clearly during auto-target selection
- `mcp/handlers.mjs` — improve `delegate_task` errors and warnings with actionable routing reasons
- `lib/taskRouting.test.mjs` and related handler tests — add routing matrix coverage
- If needed, minimal task/agent metadata additions already supported by current state shapes

**Out of scope:**
- Redesigning the full task schema or adding speculative routing metadata with no current runtime use
- Changing coordinator lease timing, claim state machine, or worker execution commands
- Adding the agent workview MCP tool itself

## Context

Today task routing mostly answers two questions: "is the agent not master?" and "does it have the listed capability tags?" That is enough to reject obviously bad dispatches, but not enough to explain why a task is undispatchable or why a target agent was refused. LLM masters need more than a boolean. They need actionable reasons they can use to re-delegate, update metadata, or explain the failure to the user.

This task should make routing explicit and inspectable without turning it into a speculative policy engine. The target is practical diagnostics: provider mismatch, role mismatch, missing capability, reserved-owner conflict, and unsupported task type should each produce a stable reason code or explanation.

**Affected files:**
- `lib/taskRouting.mjs` — routing core
- `lib/dispatchPlanner.mjs` — auto-target selection
- `mcp/handlers.mjs` — `delegate_task` result and error messages
- `lib/taskRouting.test.mjs` — unit coverage
- `mcp/handlers.test.mjs` — integration of routing reasons into MCP behavior

## Goals

1. Must evaluate task-to-agent eligibility with named failure reasons, not only a boolean.
2. Must preserve current dispatch behavior where existing routing inputs are unchanged and valid.
3. Must expose actionable reasons when `delegate_task` cannot assign a task to a requested or auto-selected worker.
4. Must cover provider, role, capability, owner, and task-type rejection paths in tests.
5. Must avoid adding speculative metadata fields that are not consumed by current dispatch logic.

## Implementation

### Step 1 — Refactor routing into an explainable result

**File:** `lib/taskRouting.mjs`

```js
export function evaluateTaskEligibility(task, agent) {
  return {
    eligible: false,
    reasons: ['missing_capability:typescript'],
  };
}

export function canAgentExecuteTask(task, agent) {
  return evaluateTaskEligibility(task, agent).eligible;
}
```

Keep the existing boolean helper as a compatibility wrapper so current call sites do not all need to change at once.

### Step 2 — Surface reasons in auto-selection and explicit delegation

**Files:** `lib/dispatchPlanner.mjs`, `mcp/handlers.mjs`

```js
if (!evaluation.eligible) {
  throw new Error(`Target agent ${agentId} cannot execute task: ${evaluation.reasons.join(', ')}`);
}
```

For auto-selection failures, return a warning payload that includes why no worker qualified instead of a bare `no_eligible_worker`.

### Step 3 — Add a routing matrix test suite

**Files:** `lib/taskRouting.test.mjs`, `mcp/handlers.test.mjs`

```js
it('returns missing_capability reason when required capability is absent');
it('returns unsupported_task_type for unknown task types');
it('returns role_ineligible for master agents');
it('returns owner_mismatch when task is reserved for another agent');
```

Cover at least one successful eligibility path too.

## Acceptance criteria

- [ ] Routing logic returns stable, actionable rejection reasons for ineligible task/agent pairs.
- [ ] `delegate_task` explicit-target failures include the routing reason(s) in the returned error text.
- [ ] Auto-selection failures return a warning payload that is more informative than `no_eligible_worker` alone.
- [ ] Existing valid routing behavior remains intact for current worker/task metadata.
- [ ] Tests cover provider/task-type/role/capability/owner rejection paths and at least one success path.
- [ ] No changes to files outside the stated scope.

## Tests

Add to `lib/taskRouting.test.mjs`:

```js
it('explains capability mismatch with a stable reason');
it('rejects master role with a role_ineligible reason');
it('rejects unsupported task types with a stable reason');
```

Add to `mcp/handlers.test.mjs`:

```js
it('handleDelegateTask surfaces routing reasons for explicit target rejection');
it('handleDelegateTask returns informative warning when no eligible worker exists');
```

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```

## Risk / Rollback

**Risk:** Changing routing error semantics could break tests or operator flows that currently match exact error strings, and richer auto-selection warnings could be misinterpreted if not kept stable.
**Rollback:** `git restore lib/taskRouting.mjs lib/dispatchPlanner.mjs mcp/handlers.mjs lib/taskRouting.test.mjs mcp/handlers.test.mjs && nvm use 24 && npm run test:orc`
