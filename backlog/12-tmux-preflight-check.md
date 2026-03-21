---
ref: general/12-tmux-preflight-check
feature: general
priority: normal
status: blocked
---

# Task 12 — Add tmux to Preflight and Doctor Checks

Depends on Task 7. Blocks Task 13.

## Scope

**In scope:**
- `lib/binaryCheck.ts`: add `tmux` to the set of checked binaries with an actionable install hint
- `cli/preflight.ts` and/or `cli/doctor.ts`: surface the tmux check in their output (follow the existing pattern for provider binary checks)

**Out of scope:**
- Any changes to `adapters/tmux.ts` or `adapters/index.ts`
- Adding tmux as a provider (it is infrastructure, not a provider)
- Removing node-pty (Task 13)

---

## Context

`orc preflight` and `orc doctor` check that required binaries are available (currently `claude`, `codex`, `gemini`). After the tmux migration, `tmux` is a required system dependency. A missing `tmux` binary currently produces a cryptic `execFileSync` failure at coordinator startup rather than a clear diagnostic.

### Current state

`lib/binaryCheck.ts` exports `isBinaryAvailable(binary)` and `checkAndInstallBinary(provider)`. Preflight and doctor call these for provider binaries. `tmux` is not checked anywhere.

### Desired state

`orc preflight` and `orc doctor` report `tmux: ok` or `tmux: MISSING — install with brew install tmux / apt install tmux` alongside the provider binary checks.

### Start here

- `lib/binaryCheck.ts` — read `isBinaryAvailable` and how install hints are structured
- `cli/preflight.ts` — see how existing binary checks are called and formatted
- `cli/doctor.ts` — see if doctor calls the same binary check path

**Affected files:**
- `lib/binaryCheck.ts` — add tmux check entry or export a dedicated `checkTmux()` helper
- `cli/preflight.ts` — call tmux check and surface result
- `cli/doctor.ts` — call tmux check and exit non-zero if missing

---

## Goals

1. Must `orc preflight` print `tmux: ok` when tmux is installed.
2. Must `orc preflight` print `tmux: MISSING` with an install hint when tmux is not on `$PATH`.
3. Must `orc doctor` exit non-zero when tmux is missing.
4. Must `orc doctor` exit 0 when tmux is present (assuming other checks pass).
5. Must reuse `isBinaryAvailable('tmux')` from `lib/binaryCheck.ts`; do not inline a separate check.

---

## Implementation

### Step 1 — Add tmux check to binaryCheck.ts

**File:** `lib/binaryCheck.ts`

Add an exported helper that follows the same pattern as existing provider checks:

```ts
export function checkTmuxAvailable(): { ok: boolean; hint?: string } {
  if (isBinaryAvailable('tmux')) return { ok: true };
  return {
    ok: false,
    hint: 'tmux not found. Install: brew install tmux  (macOS) / apt install tmux  (Linux)',
  };
}
```

### Step 2 — Surface in preflight

**File:** `cli/preflight.ts`

Import `checkTmuxAvailable` and add a check in the same section as provider binary checks:

```ts
const tmux = checkTmuxAvailable();
console.log(`tmux: ${tmux.ok ? 'ok' : `MISSING — ${tmux.hint}`}`);
```

### Step 3 — Surface in doctor

**File:** `cli/doctor.ts`

Import `checkTmuxAvailable`. If `!tmux.ok`, push an error into the doctor's error accumulator and ensure the final exit code is non-zero. Follow the exact pattern used for missing provider binaries in the same file.

---

## Acceptance criteria

- [ ] `orc preflight` prints `tmux: ok` when tmux is on `$PATH`.
- [ ] `orc preflight` prints `tmux: MISSING` with an install hint when tmux is absent.
- [ ] `orc doctor` exits non-zero when tmux is missing.
- [ ] `orc doctor` exits 0 when tmux is present (all else passing).
- [ ] `isBinaryAvailable('tmux')` is used; no inline `which`/`execSync` calls added.
- [ ] `npm test` passes.
- [ ] No changes to files outside `lib/binaryCheck.ts`, `cli/preflight.ts`, `cli/doctor.ts`.

---

## Tests

Add to `lib/binaryCheck.test.ts` (or create it):

```ts
it('checkTmuxAvailable returns ok:true when tmux is on PATH', () => {
  // mock isBinaryAvailable to return true for 'tmux'
});
it('checkTmuxAvailable returns ok:false with install hint when tmux absent', () => {
  // mock isBinaryAvailable to return false for 'tmux'
  // assert hint contains 'brew install tmux'
});
```

---

## Verification

```bash
# Targeted test
npx vitest run lib/binaryCheck

# Smoke: run preflight and confirm tmux line present
node --experimental-strip-types cli/preflight.ts 2>&1 | grep tmux

# Doctor smoke
node --experimental-strip-types cli/doctor.ts

# Full suite
nvm use 24 && npm test
```
