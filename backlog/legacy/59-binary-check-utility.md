# Task 59 — Binary Availability Check Utility (`lib/binaryCheck.mjs`)

No dependencies. Blocks Tasks 60, 61, 62.

---

## Scope

**In scope:**
- Create `lib/binaryCheck.mjs`
- Unit tests for the module

**Out of scope:**
- Calling the utility from any CLI script — that is Tasks 60 and 61
- `orc-preflight` / `orc-doctor` integration — that is Task 62
- Coordinator-side handling — that is Task 63

---

## Context

When a user registers a worker (or starts a master session) with a provider whose CLI binary is not installed, the coordinator will silently fail when it tries to spawn the PTY. This task creates the reusable utility that CLI scripts will call to detect missing binaries, prompt the user to install them, and perform the install via npm.

### Provider → binary → npm package mapping

| Provider | Binary  | npm global package          |
|----------|---------|-----------------------------|
| `claude` | `claude` | `@anthropic-ai/claude-code` |
| `codex`  | `codex`  | `@openai/codex`             |
| `gemini` | `gemini` | `@google/gemini-cli`        |

### Detection strategy

Use `execFileSync('which', [binary], { stdio: 'ignore' })` — throws when the binary is not on `$PATH`, returns normally when it is. This is POSIX-standard and covers nvm-managed installations.

### Install strategy

`npm install -g <package>` via `execFileSync` with `stdio: 'inherit'` so progress output is visible to the user. The user is informed of the exact command before it runs so they can cancel (Ctrl-C) and use Homebrew or another package manager instead.

### Non-interactive mode

If `isInteractive()` returns false, skip the prompt, print an actionable error message, and return `false`. The caller is responsible for exiting.

**Affected files:**
- `lib/binaryCheck.mjs` — created by this task
- `lib/binaryCheck.test.mjs` — created by this task

---

## Goals

1. `PROVIDER_BINARIES` and `PROVIDER_PACKAGES` maps exported for use by CLI scripts.
2. `isBinaryAvailable(binary)` returns `true`/`false`, never throws.
3. `checkAndInstallBinary(provider)` returns `true` if binary is available (pre-existing or just installed), `false` if unavailable and user declined or install failed.
4. In interactive mode, the function prompts with `@inquirer/prompts confirm` before installing.
5. The exact npm command is printed to stdout before execution so the user can cancel.
6. In non-interactive mode, prints error to stderr and returns `false` without prompting.
7. After install, re-checks with `isBinaryAvailable` to confirm success before returning `true`.

---

## Implementation

### Create `lib/binaryCheck.mjs`

```js
/**
 * lib/binaryCheck.mjs
 *
 * Utility for checking whether a provider's CLI binary is available on $PATH
 * and optionally installing it via npm when it is missing.
 */
import { execFileSync } from 'node:child_process';
import { confirm } from '@inquirer/prompts';
import { isInteractive } from './prompts.mjs';

export const PROVIDER_BINARIES = {
  claude: 'claude',
  codex:  'codex',
  gemini: 'gemini',
};

export const PROVIDER_PACKAGES = {
  claude: '@anthropic-ai/claude-code',
  codex:  '@openai/codex',
  gemini: '@google/gemini-cli',
};

/**
 * Returns true if `binary` is found on $PATH.
 * Never throws.
 */
export function isBinaryAvailable(binary) {
  try {
    execFileSync('which', [binary], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether the given provider's binary is available.
 * If missing and running interactively, prompts the user to install via npm.
 *
 * @param {string} provider  - 'claude' | 'codex' | 'gemini'
 * @returns {Promise<boolean>} true if binary is available after the call
 */
export async function checkAndInstallBinary(provider) {
  const binary  = PROVIDER_BINARIES[provider] ?? provider;
  const package_ = PROVIDER_PACKAGES[provider];

  if (isBinaryAvailable(binary)) return true;

  console.error(`\nBinary '${binary}' is not installed or not on $PATH.`);

  if (!isInteractive()) {
    console.error(`To install it, run:  npm install -g ${package_}`);
    console.error('(or use Homebrew / your preferred package manager)');
    return false;
  }

  console.log(`\nInstalling '${binary}' via npm will run:`);
  console.log(`  npm install -g ${package_}`);
  console.log('(Cancel now with Ctrl-C if you prefer Homebrew or another package manager.)\n');

  const proceed = await confirm({
    message: `Install ${package_} now?`,
    default: true,
  }).catch(() => false); // ExitPromptError on Ctrl-C → treat as no

  if (!proceed) {
    console.log('Skipped. Install manually and re-run.');
    return false;
  }

  try {
    console.log(`\nRunning: npm install -g ${package_}\n`);
    execFileSync('npm', ['install', '-g', package_], { stdio: 'inherit' });
  } catch {
    console.error(`\nInstall failed. Try manually: npm install -g ${package_}`);
    return false;
  }

  if (isBinaryAvailable(binary)) {
    console.log(`\n✓ '${binary}' is now available.`);
    return true;
  }

  console.error(`\nInstall appeared to succeed but '${binary}' is still not found on $PATH.`);
  console.error('You may need to start a new shell session for the PATH update to take effect.');
  return false;
}
```

---

## Acceptance criteria

- [ ] `isBinaryAvailable('node')` returns `true` (node is always present in the test environment).
- [ ] `isBinaryAvailable('definitely-not-a-real-binary-xyz')` returns `false`.
- [ ] `checkAndInstallBinary` returns `true` immediately when binary is available (no prompt shown).
- [ ] In non-interactive mode with missing binary: prints error, returns `false`, does not prompt.
- [ ] `PROVIDER_BINARIES` and `PROVIDER_PACKAGES` export all three providers.

---

## Tests

```js
// lib/binaryCheck.test.mjs

describe('isBinaryAvailable', () => {
  it('returns true for binaries that exist (node)', ...)
  it('returns false for binaries that do not exist', ...)
  it('never throws', ...)
});

describe('checkAndInstallBinary — binary already present', () => {
  it('returns true immediately without prompting', ...)
});

describe('checkAndInstallBinary — binary missing, non-interactive', () => {
  it('returns false and prints error with install command', ...)
  it('does not call execFileSync(npm install)', ...)
});

describe('checkAndInstallBinary — binary missing, interactive, user confirms', () => {
  it('prints the exact npm command before installing', ...)
  it('calls npm install -g with correct package', ...)
  it('returns true when install succeeds and binary is now available', ...)
  it('returns false when install succeeds but binary still not on PATH', ...)
});

describe('checkAndInstallBinary — binary missing, interactive, user declines', () => {
  it('returns false without calling npm', ...)
});
```

Mock `execFileSync` via `vi.doMock('node:child_process', ...)` and `isInteractive` via `vi.doMock('./prompts.mjs', ...)`. Use `vi.resetModules()` + dynamic import pattern.

---

## Verification

```bash
nvm use 24
node --input-type=module <<'EOF'
import { isBinaryAvailable, PROVIDER_BINARIES, PROVIDER_PACKAGES } from './lib/binaryCheck.mjs';
console.log('node:', isBinaryAvailable('node'));          // true
console.log('fake:', isBinaryAvailable('not-a-binary'));  // false
console.log('providers:', Object.keys(PROVIDER_BINARIES));
console.log('packages:', Object.values(PROVIDER_PACKAGES));
EOF

npm run test:orc:unit
```
