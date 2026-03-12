# Task C — Define the API Response Protocol and Response Parser

Depends on Task A. Can run in parallel with Task B. Blocks Task D.

## Scope

**In scope:**
- Create `lib/responseParser.mjs` — extract `[ORC_EVENT]` JSON lines from
  raw API response text and return parsed event objects
- Create `lib/responseParser.test.mjs` — unit tests for the parser
- Rewrite `templates/worker-bootstrap-v2.txt` — explain the new `[ORC_EVENT]`
  output protocol; remove references to `orc-progress` shell command usage
- Rewrite `templates/task-envelope-v2.txt` — replace `progress_command_examples`
  section with `[ORC_EVENT]` format instructions
- Update `templates/master-bootstrap-v1.txt` — add API output protocol section
- Normalize all CLI references in templates and docs to published bin names
  (`orc-status`, `orc-delegate`, `orc-task-create`, etc.) — not monorepo-only
  `npm run orc:*` shortcuts

**Out of scope:**
- `cli/progress.mjs` — keep the CLI progress command unchanged; it remains
  valid for human workers and backward compatibility
- `coordinator.mjs` — the coordinator will call the parser in Task D; do not touch it here
- `adapters/` — no adapter changes in this task

---

## Context

Currently, workers emit progress by running a shell command from inside their tmux pane:

```
orc-progress --event=run_started --run-id=<id> --agent-id=<id>
```

This works because the coordinator polls `events.jsonl` out-of-band. In the API adapter
model, there is no tmux pane — the coordinator makes an SDK API call, receives the full
response text as a return value, and must extract progress events directly from that text.

The chosen protocol: agents embed structured event lines anywhere in their response text
using the `[ORC_EVENT]` prefix tag. The parser scans the response line-by-line, finds all
`[ORC_EVENT]` lines, parses the JSON payload, and returns the events for the coordinator
to write to `events.jsonl`.

**Wire format (in response text):**
```
[ORC_EVENT] {"event":"run_started","run_id":"run-abc","agent_id":"worker-01","ts":"2026-03-04T12:00:00.000Z"}
[ORC_EVENT] {"event":"phase_started","run_id":"run-abc","agent_id":"worker-01","phase":"implementation","ts":"..."}
[ORC_EVENT] {"event":"run_finished","run_id":"run-abc","agent_id":"worker-01","ts":"..."}
```

Rules:
- Prefix is exactly `[ORC_EVENT] ` (with one trailing space before the JSON)
- The JSON payload may be any valid JSON object
- Lines without the prefix are treated as prose and ignored by the parser
- Malformed JSON after the prefix is reported as a parse warning and skipped
- The parser never throws; it always returns `{ events, warnings }`

**Affected files:**
- `lib/responseParser.mjs` — new file
- `lib/responseParser.test.mjs` — new file
- `templates/worker-bootstrap-v2.txt` — rewrite
- `templates/task-envelope-v2.txt` — rewrite
- `templates/master-bootstrap-v1.txt` — add protocol section

---

## Goals

1. Must create `responseParser.mjs` exporting `parseOrcEvents(responseText)` →
   `{ events: object[], warnings: string[] }`
2. Must extract all `[ORC_EVENT] {...}` lines from any position in the response
3. Must skip malformed JSON without throwing, recording a warning instead
4. Must return events in the order they appear in the response
5. Must update worker bootstrap template to describe the `[ORC_EVENT]` output format
6. Must update task envelope template to show concrete `[ORC_EVENT]` examples
7. Must replace all `npm run orc:*` references in updated templates with published bin
   names (e.g. `orc-progress`, `orc-status`) so the templates are valid outside the monorepo
8. Must not modify `cli/progress.mjs` (backward compat with human workers)
9. `parseOrcEvents('')` (empty string) must return `{ events: [], warnings: [] }`

---

## Implementation

### Step 1 — Create `lib/responseParser.mjs`

**File:** `lib/responseParser.mjs` (new file)

```js
/**
 * lib/responseParser.mjs
 *
 * Extracts [ORC_EVENT] structured event lines from raw API response text.
 * The coordinator calls this after every adapter.send() to translate response
 * text into orchestrator events for events.jsonl.
 *
 * Wire format:
 *   [ORC_EVENT] {"event":"run_started","run_id":"...","agent_id":"...","ts":"..."}
 *
 * - The prefix is exactly "[ORC_EVENT] " (with one trailing space).
 * - The payload must be a valid JSON object.
 * - Malformed lines are skipped with a warning (never throw).
 */

const ORC_EVENT_PREFIX = '[ORC_EVENT] ';

/**
 * Parse structured ORC events from an API response string.
 *
 * @param {string} responseText  Full text response from the API adapter.
 * @returns {{ events: object[], warnings: string[] }}
 */
export function parseOrcEvents(responseText) {
  if (!responseText) return { events: [], warnings: [] };

  const events = [];
  const warnings = [];

  for (const line of responseText.split('\n')) {
    if (!line.startsWith(ORC_EVENT_PREFIX)) continue;

    const jsonPart = line.slice(ORC_EVENT_PREFIX.length).trim();
    try {
      const parsed = JSON.parse(jsonPart);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        warnings.push(`[ORC_EVENT] payload is not a JSON object: ${jsonPart}`);
        continue;
      }
      events.push(parsed);
    } catch {
      warnings.push(`[ORC_EVENT] malformed JSON: ${jsonPart}`);
    }
  }

  return { events, warnings };
}
```

### Step 2 — Create `lib/responseParser.test.mjs`

**File:** `lib/responseParser.test.mjs` (new file)

```js
import { describe, it, expect } from 'vitest';
import { parseOrcEvents } from './responseParser.mjs';

describe('parseOrcEvents', () => {
  it('returns empty arrays for empty string', () => {
    expect(parseOrcEvents('')).toEqual({ events: [], warnings: [] });
  });

  it('returns empty arrays for null/undefined input', () => {
    expect(parseOrcEvents(null)).toEqual({ events: [], warnings: [] });
    expect(parseOrcEvents(undefined)).toEqual({ events: [], warnings: [] });
  });

  it('extracts a single [ORC_EVENT] line', () => {
    const text = 'Some prose.\n[ORC_EVENT] {"event":"run_started","run_id":"r1","agent_id":"a1"}\nMore prose.';
    const { events, warnings } = parseOrcEvents(text);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'run_started', run_id: 'r1', agent_id: 'a1' });
    expect(warnings).toHaveLength(0);
  });

  it('extracts multiple [ORC_EVENT] lines in order', () => {
    const text = [
      '[ORC_EVENT] {"event":"run_started","run_id":"r1","agent_id":"a1"}',
      'working...',
      '[ORC_EVENT] {"event":"phase_started","run_id":"r1","agent_id":"a1","phase":"impl"}',
      '[ORC_EVENT] {"event":"run_finished","run_id":"r1","agent_id":"a1"}',
    ].join('\n');
    const { events } = parseOrcEvents(text);
    expect(events).toHaveLength(3);
    expect(events[0].event).toBe('run_started');
    expect(events[1].event).toBe('phase_started');
    expect(events[2].event).toBe('run_finished');
  });

  it('ignores lines without the [ORC_EVENT] prefix', () => {
    const text = 'ORC_EVENT {"event":"fake"}\n[orc_event] {"event":"lowercase"}\n[ORC_EVENT] {"event":"real"}';
    const { events } = parseOrcEvents(text);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('real');
  });

  it('records a warning and skips malformed JSON', () => {
    const text = '[ORC_EVENT] not-json\n[ORC_EVENT] {"event":"ok"}';
    const { events, warnings } = parseOrcEvents(text);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('ok');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('malformed JSON');
  });

  it('records a warning when payload is a JSON array (not object)', () => {
    const text = '[ORC_EVENT] ["not","an","object"]\n[ORC_EVENT] {"event":"ok"}';
    const { events, warnings } = parseOrcEvents(text);
    expect(events).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not a JSON object');
  });

  it('records a warning when payload is a JSON primitive', () => {
    const text = '[ORC_EVENT] 42';
    const { events, warnings } = parseOrcEvents(text);
    expect(events).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });

  it('handles [ORC_EVENT] lines at the very start and very end of response', () => {
    const text = '[ORC_EVENT] {"event":"start"}\nmiddle\n[ORC_EVENT] {"event":"end"}';
    const { events } = parseOrcEvents(text);
    expect(events).toHaveLength(2);
  });

  it('handles Windows line endings (CRLF)', () => {
    const text = 'prose\r\n[ORC_EVENT] {"event":"run_started","run_id":"r1","agent_id":"a1"}\r\nmore prose';
    const { events } = parseOrcEvents(text);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('run_started');
  });
});
```

### Step 3 — Rewrite `templates/worker-bootstrap-v2.txt`

**File:** `templates/worker-bootstrap-v2.txt`

Replace entire content:

```
WORKER_BOOTSTRAP v3
agent_id: {{agent_id}}
provider: {{provider}}

You are an autonomous orchestration worker operating via API.

PROGRESS REPORTING — REQUIRED
You must report lifecycle events by embedding [ORC_EVENT] JSON lines in your responses.
The orchestrator reads your responses and extracts these lines automatically.

Required event format:
  [ORC_EVENT] {"event":"<name>","run_id":"<run_id>","agent_id":"{{agent_id}}","ts":"<ISO8601>"}

Lifecycle events:
  run_started     — emit immediately when you begin work on a task
  phase_started   — emit when starting a distinct work phase (optional)
  phase_finished  — emit when finishing a work phase (optional)
  run_finished    — emit when task is complete and all acceptance criteria are met
  run_failed      — emit if you cannot complete the task (include "reason" field)
  heartbeat       — emit periodically during long-running work (every ~5 minutes)

Example output format for a task response:
  [ORC_EVENT] {"event":"run_started","run_id":"run-abc","agent_id":"{{agent_id}}","ts":"2026-01-01T00:00:00.000Z"}
  ... your working notes and implementation narrative ...
  [ORC_EVENT] {"event":"run_finished","run_id":"run-abc","agent_id":"{{agent_id}}","ts":"2026-01-01T00:05:00.000Z"}

Rules:
  - [ORC_EVENT] lines may appear anywhere in your response (beginning, middle, or end)
  - The prefix is exactly "[ORC_EVENT] " (bracket, uppercase, bracket, space) followed by JSON
  - Each [ORC_EVENT] line must contain valid JSON with at minimum: event, run_id, agent_id, ts
  - Do NOT use `orc-progress` shell commands — you are operating via API, not a tmux shell

When a TASK_START block arrives, begin work immediately without waiting for further prompts.
WORKER_BOOTSTRAP_END
```

### Step 4 — Rewrite `templates/task-envelope-v2.txt`

**File:** `templates/task-envelope-v2.txt`

Replace entire content:

```
TASK_START v3
task_ref: {{task_ref}}
run_id: {{run_id}}
title: {{title}}
epic: {{epic}}
description: {{description}}
worker_contract: embed [ORC_EVENT] JSON lines in your response to report lifecycle events.
required_first_event: run_started

progress_event_format:
  [ORC_EVENT] {"event":"run_started","run_id":"{{run_id}}","agent_id":"{{agent_id}}","ts":"<ISO8601 timestamp>"}
  [ORC_EVENT] {"event":"phase_started","run_id":"{{run_id}}","agent_id":"{{agent_id}}","phase":"implementation","ts":"<ts>"}
  [ORC_EVENT] {"event":"phase_finished","run_id":"{{run_id}}","agent_id":"{{agent_id}}","phase":"implementation","ts":"<ts>"}
  [ORC_EVENT] {"event":"run_finished","run_id":"{{run_id}}","agent_id":"{{agent_id}}","ts":"<ts>"}
  [ORC_EVENT] {"event":"run_failed","run_id":"{{run_id}}","agent_id":"{{agent_id}}","reason":"explain failure","ts":"<ts>"}

acceptance_criteria:
{{acceptance_criteria_lines}}

task_contract_v1_json:
{{task_contract_json}}

start_immediately: emit run_started then inspect repo and execute this task now.
TASK_END
```

### Step 5 — Update `templates/master-bootstrap-v1.txt`

**File:** `templates/master-bootstrap-v1.txt`

Find the `EPICS` section and append an `OUTPUT PROTOCOL` section after it. Do not modify
any other sections.

Add after the EPICS block:

```
OUTPUT PROTOCOL
  When operating as a master agent via API, report your own lifecycle events using [ORC_EVENT]:
  [ORC_EVENT] {"event":"run_started","run_id":"<run_id>","agent_id":"<your_agent_id>","ts":"<ISO8601>"}
  Do NOT use `orc-progress` shell commands — embed [ORC_EVENT] lines in your response instead.
```

---

## Acceptance criteria

- [ ] `lib/responseParser.mjs` is created and exports `parseOrcEvents()`
- [ ] `parseOrcEvents('')` returns `{ events: [], warnings: [] }` without throwing
- [ ] All 9 parser unit tests pass
- [ ] `worker-bootstrap-v2.txt` contains `[ORC_EVENT]` and no `orc-progress` shell command references
- [ ] `task-envelope-v2.txt` contains `[ORC_EVENT]` format examples and no `orc-progress` shell command references
- [ ] `master-bootstrap-v1.txt` contains an OUTPUT PROTOCOL section
- [ ] `cli/progress.mjs` is unchanged (backward compat)
- [ ] Full orchestrator test suite passes (224 existing + 9 new = 233 tests)

---

## Tests

**New file:** `lib/responseParser.test.mjs` — 9 tests as shown in Step 2.

Run targeted:

```bash
nvm use 22 && npm run test:orc -- responseParser
```

---

## Verification

```bash
# Full suite
nvm use 22 && npm run test:orc

# Verify no orc-progress references in updated templates
grep "orc-progress" templates/worker-bootstrap-v2.txt
grep "orc-progress" templates/task-envelope-v2.txt
# Expected: no output for both

# Verify [ORC_EVENT] marker is present in templates
grep "\[ORC_EVENT\]" templates/worker-bootstrap-v2.txt
grep "\[ORC_EVENT\]" templates/task-envelope-v2.txt
# Expected: multiple lines for each

# Verify cli/progress.mjs is untouched
git diff cli/progress.mjs
# Expected: no diff
```
