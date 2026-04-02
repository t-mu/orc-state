---
ref: publish/101-extract-install-shared-logic
feature: publish
priority: normal
status: done
---

# Task 101 — Extract Shared Logic from install-skills and install-agents

Independent.

## Scope

**In scope:**
- Refactor `cli/install-skills.ts` to export an `installSkills(providers, base, dryRun)` function
- Refactor `cli/install-agents.ts` to export an `installAgents(providers, base, dryRun)` function
- Keep existing CLI entry points working as thin wrappers around the exported functions

**Out of scope:**
- Creating the unified `orc install` command (Task 103)
- Adding Gemini provider support
- Changing what files are copied or how they're copied
- Modifying any other CLI commands

---

## Context

`cli/install-skills.ts` and `cli/install-agents.ts` currently do everything inline — flag parsing, provider validation, file copying, and reporting. The upcoming unified `orc install` command needs to call the same copy logic without going through CLI flag parsing. Extracting the core logic into importable functions enables reuse.

### Current state

Both files parse flags, validate providers, and copy files in a single inline flow at the module top level. Neither exports any functions, and neither has an `isMainModule` guard — all code runs unconditionally on import.

### Desired state

Both files export their core logic as functions. Top-level side effects are wrapped behind an `isMainModule` guard (imported from `cli/orc.ts` or duplicated). `cli/install.ts` (Task 103) can import the functions without triggering CLI execution.

### Start here

- `cli/install-skills.ts` — current inline implementation
- `cli/install-agents.ts` — current inline implementation

**Affected files:**
- `cli/install-skills.ts` — extract `installSkills()` function
- `cli/install-agents.ts` — extract `installAgents()` function

---

## Goals

1. Must export `installSkills(providers: string[], base: string, dryRun: boolean)` from `cli/install-skills.ts`.
2. Must export `installAgents(providers: string[], base: string, dryRun: boolean)` from `cli/install-agents.ts`.
3. Must wrap top-level side effects behind an `isMainModule` guard so imports don't trigger CLI execution.
4. Must not change external behavior of `orc install-skills` and `orc install-agents` CLI commands.
5. Must return a result object with count of files copied and list of paths.

---

## Implementation

### Step 1 — Extract installSkills function

**File:** `cli/install-skills.ts`

Move the provider validation, directory enumeration, and file copying logic into:

```ts
export interface InstallResult {
  copied: string[];
  count: number;
}

export function installSkills(providers: string[], base: string, dryRun: boolean): InstallResult
```

The existing top-level code currently runs unconditionally on import. Wrap it in an
`isMainModule` guard so the module can be imported without side effects:

```ts
import { isMainModule } from './orc.ts';

// ... export function installSkills(...) { ... }

if (isMainModule(process.argv[1], import.meta.url)) {
  const providers = parseProviderFlag();
  const base = globalFlag ? homedir() : process.cwd();
  const result = installSkills(providers, base, boolFlag('dry-run'));
  console.log(`Installed ${result.count} skill files`);
}
```

### Step 2 — Extract installAgents function

**File:** `cli/install-agents.ts`

Same pattern:

```ts
export function installAgents(providers: string[], base: string, dryRun: boolean): InstallResult
```

---

## Acceptance criteria

- [ ] `installSkills` is exported and callable with `(providers, base, dryRun)`.
- [ ] `installAgents` is exported and callable with `(providers, base, dryRun)`.
- [ ] `orc install-skills --provider=claude --dry-run` produces identical output to before.
- [ ] `orc install-agents --provider=claude --dry-run` produces identical output to before.
- [ ] Both functions return `{ copied: string[], count: number }`.
- [ ] `npm test` passes.
- [ ] No changes to files outside `cli/install-skills.ts` and `cli/install-agents.ts`.

---

## Tests

Existing tests (if any) for install-skills and install-agents must continue to pass. Add to `cli/install-skills.test.ts` if it exists:

```ts
it('installSkills returns copied file list', () => { ... });
```

---

## Verification

```bash
# Verify exports exist
node -e "import('./cli/install-skills.ts').then(m => console.log('installSkills:', typeof m.installSkills))"
node -e "import('./cli/install-agents.ts').then(m => console.log('installAgents:', typeof m.installAgents))"

# Verify CLI still works
node cli/orc.ts install-skills --dry-run
node cli/orc.ts install-agents --dry-run

# Full suite
nvm use 24 && npm test
```
