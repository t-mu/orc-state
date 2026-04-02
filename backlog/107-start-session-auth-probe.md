---
ref: publish/107-start-session-auth-probe
feature: publish
priority: high
status: todo
depends_on:
  - publish/106-init-provider-binary-validation
---

# Task 107 — Add Provider Auth Probe to `orc start-session`

Depends on Task 106 (binary validation in init must exist).

## Scope

**In scope:**
- Before spawning the master session in `cli/start-session.ts`, run a lightweight auth probe for the selected provider
- Exit with an actionable error if auth fails
- Support Claude, Codex, and Gemini providers

**Out of scope:**
- Changing `orc init` (handled in task 106)
- Full API validation or model availability checks
- Modifying the coordinator startup flow

---

## Context

### Current state

`orc start-session` checks that the provider binary exists on PATH via `checkAndInstallBinary()`, then spawns the master PTY session. If the user is not authenticated, the provider CLI starts and immediately fails with a provider-specific error message (e.g. "Authentication failed"). The orchestrator does not surface this clearly — the user sees raw provider output.

### Desired state

Before spawning the master session, `orc start-session` runs a lightweight probe command for the selected provider. If auth fails, it exits 1 with a clear message like: *"Provider 'claude' is installed but not authenticated. Run `claude` to set up your API key."*

Probe commands per provider:
- **Claude:** `claude --version` (exits 0 only when authenticated/installed)
- **Codex:** `codex --version` or equivalent
- **Gemini:** `gemini --version` or equivalent

The probe must be fast (<2s), have no side effects, and work offline where possible.

### Start here

- `cli/start-session.ts` — session startup handler (line ~253 for binary check)
- `lib/binaryCheck.ts` — existing binary detection

**Affected files:**
- `cli/start-session.ts` — add auth probe before session spawn
- `lib/binaryCheck.ts` — optionally add `probeAuth(provider)` helper
- `cli/start-session.test.ts` — add tests

---

## Goals

1. Must probe provider auth before spawning the master PTY session
2. Must exit 1 with an actionable error message naming the provider and suggesting a fix
3. Must not add more than 2 seconds of latency to `orc start-session`
4. Must handle all three providers (claude, codex, gemini)
5. Must not break the existing binary check flow

---

## Implementation

### Step 1 — Add auth probe helper

**File:** `lib/binaryCheck.ts`

```typescript
export function probeProviderAuth(provider: string): { ok: boolean; message?: string } {
  const commands: Record<string, string[]> = {
    claude: ['claude', '--version'],
    codex: ['codex', '--version'],
    gemini: ['gemini', '--version'],
  };
  const cmd = commands[provider];
  if (!cmd) return { ok: true }; // unknown provider, skip probe
  try {
    execSync(cmd.join(' '), { stdio: 'pipe', timeout: 5000 });
    return { ok: true };
  } catch {
    return {
      ok: false,
      message: `Provider '${provider}' is installed but not authenticated or not working. Run \`${provider}\` to verify setup.`,
    };
  }
}
```

### Step 2 — Call probe in start-session

**File:** `cli/start-session.ts`

After the binary check and before spawning the master session:

```typescript
const authResult = probeProviderAuth(provider);
if (!authResult.ok) {
  cliError(authResult.message);
}
```

### Step 3 — Add tests

**File:** `cli/start-session.test.ts`

Test that auth probe failure prevents session spawn and shows actionable error.

---

## Acceptance criteria

- [ ] `orc start-session` with an unauthenticated provider exits 1 before spawning a PTY session
- [ ] Error message includes the provider name and suggests running the provider CLI directly
- [ ] Auth probe adds no more than 2 seconds latency when provider is authenticated
- [ ] Probe works for claude, codex, and gemini providers
- [ ] Existing `orc start-session` flow is not broken when auth is valid
- [ ] No changes to files outside the stated scope

---

## Tests

Add to `cli/start-session.test.ts`:

```typescript
it('exits with actionable error when provider auth probe fails', () => { ... });
it('proceeds normally when provider auth probe succeeds', () => { ... });
```

---

## Verification

```bash
npx vitest run cli/start-session.test.ts
```

```bash
nvm use 24 && npm test
```
