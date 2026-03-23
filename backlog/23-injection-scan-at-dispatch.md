---
ref: general/23-injection-scan-at-dispatch
feature: general
priority: normal
status: todo
---

# Task 23 — Apply Injection Scan to Task Spec Content at Dispatch

Depends on Task 22. Blocks no other task.

## Scope

**In scope:**
- Call `scanForInjection()` on the full raw markdown content of a task spec before `parseTaskSpecSections()` returns it
- Emit a `task_dispatch_blocked` event to `events.jsonl` when a scan fails, carrying `reason` and `findings`
- Add the new event type to the event schema/validation if it is not already present
- Unit tests covering the blocked-dispatch path in `lib/taskSpecReader.test.ts`

**Out of scope:**
- Scanning AGENTS.md, master bootstrap templates, or PTY output
- Auto-sanitizing or stripping detected content
- Blocking the task permanently — on scan failure the task stays in its current status (not moved to `blocked`)
- Changes to the coordinator dispatch loop beyond what is needed to catch and log the error
- Changes to `lib/promptInjectionScan.ts` (delivered by Task 22)

---

## Context

`lib/taskSpecReader.ts` exports `readTaskSpecSections(taskRef)` which reads the raw markdown file, strips HTML comments, and returns the parsed section strings. The coordinator calls this at dispatch time to build the task envelope delivered to the worker. The sections are injected verbatim into the worker's system prompt context.

A task spec that contains a prompt-injection payload (inserted accidentally or maliciously) would reach the worker's effective context window unchecked. The fix is to scan the full raw content immediately before it is parsed and returned, so any poisoned spec is stopped at the source.

### Dependency context

Task 22 delivers `lib/promptInjectionScan.ts` with `scanForInjection(text): ScanResult`. This task wires it into the read path. Assume `scanForInjection` is already available at `lib/promptInjectionScan.ts` when implementing this task.

### Current state

`readTaskSpecSections()` in `lib/taskSpecReader.ts` calls `readMarkdownTaskSpec()` to load the file, then immediately passes the content to `parseTaskSpecSections()`. No scan occurs between file read and parse.

```ts
// current — no scan
export function readTaskSpecSections(taskRef: string, ...): TaskSpecSections & { source_path } {
  const spec = readMarkdownTaskSpec(taskRef, docsDir);
  if (!spec) return { ..., source_path: null };
  return { ...parseTaskSpecSections(spec.content), source_path: spec.path };
}
```

### Desired state

`readTaskSpecSections()` scans `spec.content` with `scanForInjection()` before parsing. If `safe === false`, it throws an `InjectionScanError` (a named error subclass carrying `findings`). The coordinator catches this error, appends a `task_dispatch_blocked` event, and does not dispatch the worker. The task remains in its current status.

**Affected files:**
- `lib/taskSpecReader.ts` — add scan call and error throw
- `lib/promptInjectionScan.ts` — consumed (do not modify)
- `lib/eventValidation.ts` or the event types file — add `task_dispatch_blocked` event type if absent
- `lib/taskSpecReader.test.ts` — add blocked-dispatch test cases

---

## Goals

1. Must call `scanForInjection(spec.content)` inside `readTaskSpecSections()` before returning parsed sections.
2. Must throw a named `InjectionScanError` carrying `findings: string[]` when `safe === false`.
3. Must not alter the return type or behavior of `readTaskSpecSections()` for clean specs.
4. Must emit a `task_dispatch_blocked` event to `events.jsonl` when an injection scan error is caught at dispatch, with fields `reason: "injection_scan_failed"` and `findings`.
5. Must leave the task in its current status — do not transition it to `blocked`.
6. Must have at least two new tests in `lib/taskSpecReader.test.ts`: one for the blocked path and one confirming clean specs are unaffected.

---

## Implementation

### Step 1 — Add InjectionScanError and scan call to taskSpecReader.ts

**File:** `lib/taskSpecReader.ts`

```ts
import { scanForInjection } from './promptInjectionScan.ts';

export class InjectionScanError extends Error {
  constructor(public readonly findings: string[]) {
    super(`Task spec failed injection scan: ${findings.join('; ')}`);
    this.name = 'InjectionScanError';
  }
}

export function readTaskSpecSections(taskRef: string, docsDir = BACKLOG_DOCS_DIR) {
  const spec = readMarkdownTaskSpec(taskRef, docsDir);
  if (!spec) return { current_state: '', desired_state: '', start_here: '', verification: '', source_path: null };

  const scanResult = scanForInjection(spec.content);
  if (!scanResult.safe) {
    throw new InjectionScanError(scanResult.findings);
  }

  return { ...parseTaskSpecSections(spec.content), source_path: spec.path };
}
```

Invariant: the return type for clean specs is identical to the current return type.

### Step 2 — Add task_dispatch_blocked event type

**File:** `types/events.ts` (or wherever event types are defined — inspect first)

Add `task_dispatch_blocked` as a valid event type with fields:
```ts
{ event: 'task_dispatch_blocked'; task_ref: string; reason: string; findings: string[] }
```

Also update `lib/eventValidation.ts` if it maintains an explicit allowed-event-types list.

### Step 3 — Catch InjectionScanError at dispatch and emit event

**File:** The coordinator file that calls `readTaskSpecSections()` at dispatch time (inspect to find the exact callsite — likely `coordinator.ts` or a dispatch helper).

Wrap the call:
```ts
try {
  const sections = readTaskSpecSections(taskRef);
  // ... continue dispatch
} catch (err) {
  if (err instanceof InjectionScanError) {
    appendSequencedEvent(stateDir, {
      event: 'task_dispatch_blocked',
      task_ref: taskRef,
      reason: 'injection_scan_failed',
      findings: err.findings,
    });
    return; // do not dispatch worker; task stays in current status
  }
  throw err; // re-throw unexpected errors
}
```

---

## Acceptance criteria

- [ ] `readTaskSpecSections()` calls `scanForInjection()` on the raw spec content before parsing.
- [ ] A spec containing an injection phrase throws `InjectionScanError` with a non-empty `findings` array.
- [ ] A clean spec returns sections normally with no change to the return shape.
- [ ] The coordinator catches `InjectionScanError` and emits a `task_dispatch_blocked` event.
- [ ] The `task_dispatch_blocked` event carries `task_ref`, `reason: "injection_scan_failed"`, and `findings`.
- [ ] The task is not transitioned to `blocked` status — it remains in its current state.
- [ ] `npm test` passes including all pre-existing `taskSpecReader` tests.
- [ ] `orc doctor` exits 0 after the event schema addition.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/taskSpecReader.test.ts`:

```ts
it('throws InjectionScanError when spec content contains an injection phrase', () => {
  // Write a temp spec file containing "ignore previous instructions"
  // Call readTaskSpecSections() on it
  // Expect InjectionScanError to be thrown with findings.length > 0
});

it('returns sections normally for a clean spec', () => {
  // Write a temp spec file with no injection content
  // Call readTaskSpecSections()
  // Expect normal TaskSpecSections shape returned
});
```

---

## Verification

```bash
npx vitest run lib/taskSpecReader.test.ts lib/promptInjectionScan.test.ts
```

```bash
nvm use 24 && npm test
```

```bash
orc doctor
# Expected: exits 0, no validation errors
```

## Risk / Rollback

**Risk:** If the event schema validation has a strict allowed-types list that is not updated, `appendSequencedEvent` will throw when emitting `task_dispatch_blocked`, which would bubble up as an unhandled coordinator error instead of a clean skip.

**Rollback:** `git restore lib/taskSpecReader.ts lib/eventValidation.ts types/events.ts` and `npm test`.
