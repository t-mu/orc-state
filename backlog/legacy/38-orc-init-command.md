# Task 38 — Add `orc-init` Command for Initial State Scaffold

Feature addition. Independent — no dependencies on other tasks.

## Scope

**In scope:**
- Create `cli/init.mjs` — a new CLI tool that scaffolds the initial state directory
- Register `orc-init` binary in `orchestrator/package.json`
- Write the initial `backlog.json`, `agents.json`, `claims.json`, and `events.jsonl` with
  correct structure and a sample epic
- Guard against overwriting an existing state directory (require `--force` flag)
- Add tests for `init.mjs`

**Out of scope:**
- Creating any agent registrations (users do that with `orc-worker-register`)
- Starting the coordinator
- Changing any existing CLI tool

---

## Context

New users of `@t-mu/orc-state` must manually create four state files before the
coordinator will start. The `coordinator.mjs::main()` checks for their existence and exits
with an error if any are missing:

```
[coordinator] ERROR: required state file missing: backlog.json
```

There is no documented init command. Users must read the contracts doc, understand the JSON
schema, and create correctly structured files by hand. This is a significant onboarding
friction point.

An `orc-init` command lowers the barrier to a single command:

```bash
orc-init --epic=my-project --epic-title="My Project"
```

**Affected files:**
- `cli/init.mjs` — new file
- `orchestrator/package.json` — add `"orc-init": "./cli/init.mjs"` to `bin`
- `cli/init.test.mjs` — new test file

---

## Goals

1. Must create `backlog.json`, `agents.json`, `claims.json`, and `events.jsonl` in `STATE_DIR`
2. Must create valid files that pass `validateStateDir`
3. Must print the paths of created files and a follow-up usage hint
4. Must exit with error if any file already exists (unless `--force` is passed)
5. With `--force`, back up each existing file to `<name>.bak` before overwriting, then write fresh empty state
6. Must accept `--epic=<ref>` and `--epic-title=<title>` to create an initial epic in backlog
7. Must work with `ORCH_STATE_DIR` env var (uses the same `STATE_DIR` path resolution as all other tools)
8. Must create the state directory itself if it does not exist (`mkdirSync` with recursive)

---

## Implementation

### Step 1 — Create `cli/init.mjs`

```js
#!/usr/bin/env node
/**
 * cli/init.mjs
 * Usage:
 *   node cli/init.mjs [--epic=<ref>] [--epic-title=<title>] [--force]
 *
 * Creates the initial orchestrator state directory with empty state files.
 */
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../lib/paths.mjs';
import { flag } from '../lib/args.mjs';
import { validateStateDir } from '../lib/stateValidation.mjs';

const force = process.argv.includes('--force') || (flag('force') ?? '') === 'true';
const epicRef = flag('epic') ?? 'project';
const epicTitle = flag('epic-title') ?? 'Project';

const STATE_FILES = ['backlog.json', 'agents.json', 'claims.json', 'events.jsonl'];

// Check for existing files.
const existing = STATE_FILES.filter((f) => existsSync(join(STATE_DIR, f)));
if (existing.length > 0 && !force) {
  console.error(`State directory already contains files: ${existing.join(', ')}`);
  console.error(`Use --force to overwrite.`);
  process.exit(1);
}

// Create directory if needed.
mkdirSync(STATE_DIR, { recursive: true });

// Back up existing files before overwriting (always happens when --force overwrites).
if (force) {
  for (const f of existing) {
    copyFileSync(join(STATE_DIR, f), join(STATE_DIR, `${f}.bak`));
    console.log(`  backed up ${f} → ${f}.bak`);
  }
}

// Write initial state files.
const backlog = {
  version: '1',
  epics: [
    {
      ref: epicRef,
      title: epicTitle,
      tasks: [],
    },
  ],
};

const agents = { version: '1', agents: [] };
const claims = { version: '1', claims: [] };

writeFileSync(join(STATE_DIR, 'backlog.json'), JSON.stringify(backlog, null, 2) + '\n', 'utf8');
writeFileSync(join(STATE_DIR, 'agents.json'), JSON.stringify(agents, null, 2) + '\n', 'utf8');
writeFileSync(join(STATE_DIR, 'claims.json'), JSON.stringify(claims, null, 2) + '\n', 'utf8');
writeFileSync(join(STATE_DIR, 'events.jsonl'), '', 'utf8');

// Validate what we just wrote.
const errors = validateStateDir(STATE_DIR);
if (errors.length > 0) {
  console.error('ERROR: generated state files are invalid:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`Initialized orchestrator state in: ${STATE_DIR}`);
console.log(`  backlog.json  — 1 epic (${epicRef})`);
console.log(`  agents.json   — 0 agents`);
console.log(`  claims.json   — 0 claims`);
console.log(`  events.jsonl  — empty`);
console.log('');
console.log('Next steps:');
console.log(`  orc-worker-register <id> --provider=<claude|codex|gemini>`);
console.log(`  orc-task-create --epic=${epicRef} --title="First task" --ac="Done"`);
console.log(`  orc-delegate --task-ref=${epicRef}/<slug>`);
console.log(`  orc-coordinator`);
```

### Step 2 — Register in `orchestrator/package.json`

**File:** `orchestrator/package.json`

Add to the `"bin"` object:

```json
"orc-init": "./cli/init.mjs"
```

### Step 3 — Create `cli/init.test.mjs`

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
let dir;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orc-init-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function run(args = [], env = {}) {
  return spawnSync('node', ['cli/init.mjs', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: join(dir, 'state'), ...env },
    encoding: 'utf8',
  });
}

describe('orc-init', () => {
  it('creates all four state files', () => {
    const result = run();
    expect(result.status).toBe(0);
    const stateDir = join(dir, 'state');
    expect(existsSync(join(stateDir, 'backlog.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'agents.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'claims.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'events.jsonl'))).toBe(true);
  });

  it('creates a default epic in backlog.json', () => {
    run();
    const backlog = JSON.parse(readFileSync(join(dir, 'state', 'backlog.json'), 'utf8'));
    expect(backlog.epics).toHaveLength(1);
    expect(backlog.epics[0].ref).toBe('project');
  });

  it('creates epic with custom ref and title', () => {
    run(['--epic=myapp', '--epic-title=My App']);
    const backlog = JSON.parse(readFileSync(join(dir, 'state', 'backlog.json'), 'utf8'));
    expect(backlog.epics[0].ref).toBe('myapp');
    expect(backlog.epics[0].title).toBe('My App');
  });

  it('exits 1 if state files already exist without --force', () => {
    run(); // first init
    const result = run(); // second init — should fail
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already contains');
  });

  it('backs up existing files and overwrites with --force', () => {
    run(); // first init — creates state files
    const result = run(['--force']); // second init with force
    expect(result.status).toBe(0);
    const stateDir = join(dir, 'state');
    // Backup files must exist alongside the fresh files.
    expect(existsSync(join(stateDir, 'backlog.json.bak'))).toBe(true);
    expect(existsSync(join(stateDir, 'agents.json.bak'))).toBe(true);
    expect(existsSync(join(stateDir, 'claims.json.bak'))).toBe(true);
    expect(existsSync(join(stateDir, 'events.jsonl.bak'))).toBe(true);
  });

  it('generated state passes validateStateDir', () => {
    // run() calls validateStateDir internally and exits 1 if invalid
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Initialized');
  });
});
```

---

## Acceptance criteria

- [ ] `orc-init` creates `backlog.json`, `agents.json`, `claims.json`, `events.jsonl` in `STATE_DIR`
- [ ] Created files pass `validateStateDir` (verified internally by the command)
- [ ] `orc-init` exits 0 with a usage hint on success
- [ ] `orc-init` exits 1 with a descriptive error if files already exist (without `--force`)
- [ ] `orc-init --force` copies each existing file to `<name>.bak` before overwriting, then exits 0
- [ ] `--epic=<ref>` and `--epic-title=<title>` create a named epic in backlog
- [ ] `orc-init` is registered as a binary in `orchestrator/package.json`
- [ ] State directory is created if it does not exist
- [ ] All new tests pass; all existing tests pass

---

## Tests

`cli/init.test.mjs` with at minimum 5 tests as described in Step 3.

---

## Verification

```bash
nvm use 22 && npm run test:orc

# Manual smoke test
ORCH_STATE_DIR=/tmp/orc-smoke-test node cli/init.mjs --epic=smoke --epic-title="Smoke Test"
node cli/preflight.mjs  # Expected: "Preflight passed" (no workers registered = warning, not error)
node cli/status.mjs --json  # Expected: valid JSON with 0 agents, 0 tasks
```

---

## Risk / Rollback

**Risk:** With `--force`, all existing state (backlog tasks, agent registrations, claims history)
is permanently destroyed. This is the intended behaviour — `--force` is an explicit destructive
operation. The `--force` flag requires intentional opt-in.

**Rollback:** Restore state files from git or backup. The command creates no lock file and
does not touch `events.jsonl` archives.
