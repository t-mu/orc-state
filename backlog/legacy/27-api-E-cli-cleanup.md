# Task E — OS-Agnostic CLI Tool Cleanup

Depends on Task B (adapters must already be rewritten). Can run in parallel with Tasks C, D.

## Scope

**In scope:**
- `cli/doctor.mjs` — remove `checkTmuxAccess()` and `checkProviderCli()`;
  add API key presence checks for each registered provider
- `cli/preflight.mjs` — remove tmux/CLI hint text from suggested actions
- `cli/start-worker-session.mjs` — rewrite: remove all tmux references,
  `forceRebind` attach logic; keep register+session-init flow with API adapters
- `cli/attach.mjs` — remove tmux-interactive path; delegate to `adapter.attach()`
  which now prints last response (no interactive terminal)
- `cli/gc-workers.mjs` — remove tmux-specific commentary; logic is already
  adapter-agnostic (uses `adapter.heartbeatProbe()`)
- `cli/clear-workers.mjs` — no code changes needed (already adapter-agnostic);
  update JSDoc comment only
- All CLI test files for the affected tools

**Out of scope:**
- `cli/watch.mjs` — no tmux dependencies; leave unchanged
- `cli/status.mjs` — no tmux dependencies; leave unchanged
- `cli/progress.mjs` — backward-compat; leave unchanged
- `coordinator.mjs` (Task D)
- Adapter files (Task B)

---

## Context

Several CLI tools were written with the assumption that workers live in tmux windows:

- **`doctor.mjs`** calls `spawnSync('tmux', ['list-sessions'])` and `spawnSync('which', [binary])`
  to check tmux access and provider CLI binaries (e.g. `which codex`). In API mode, there
  is no tmux session and no CLI binary to check — the relevant health signal is whether
  the API key environment variable is set.

- **`preflight.mjs`** hints at `orc:worker:clearall` and `orc:worker:start-session:<provider>`
  in its suggested-actions output. These hint strings reference tmux-era workflows.

- **`start-worker-session.mjs`** passes `tmux_session` and `launch_cmd` to `adapter.start()`
  and auto-attaches via `adapter.attach()` (which in tmux mode replaced stdio). In API
  mode, `adapter.start()` ignores those config keys, and `adapter.attach()` prints the
  last response — there is no session to "attach" to interactively. The tool should still
  register the agent and initialize an API session, but the attach step becomes a no-op
  or a "print last response" call.

- **`attach.mjs`** calls `adapter.attach()` which in tmux mode did `execvp('tmux', ...)`.
  In API mode `adapter.attach()` prints the last response text to stdout. The CLI tool
  needs no code changes beyond removing the "attaching to tmux" log message — but it
  should print a descriptive message instead.

- **`gc-workers.mjs`** and **`clear-workers.mjs`** already use `adapter.heartbeatProbe()`
  and are adapter-agnostic; the only changes are JSDoc comments.

**Affected files:**
- `cli/doctor.mjs` — significant rewrite
- `cli/preflight.mjs` — hint text update only
- `cli/start-worker-session.mjs` — remove tmux config keys + auto-attach
- `cli/attach.mjs` — update log message
- `cli/gc-workers.mjs` — JSDoc comment update only
- `cli/clear-workers.mjs` — JSDoc comment update only
- `cli/doctor.test.mjs` — update tests for new health checks
- `cli/preflight.test.mjs` — minor update if hint text is tested

---

## Goals

1. Must remove all `spawnSync('tmux', ...)` and `spawnSync('which', ...)` calls from
   `doctor.mjs`
2. Must add API key presence checks to `doctor.mjs` for each provider used by registered
   agents (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`)
3. Must keep `doctor.mjs` `--json` output shape backward-compatible (add new fields, do
   not remove existing ones where data is still meaningful)
4. Must keep `start-worker-session.mjs` functional for registering + initializing an API
   session without any tmux assumptions
5. Must not break any existing CLI tests for tools that are not being modified
6. `grep -r "spawnSync.*tmux\|'tmux'" cli/` → no matches after this task

---

## Implementation

### Step 1 — Rewrite `cli/doctor.mjs`

**File:** `cli/doctor.mjs`

Remove: `import { spawnSync } from 'node:child_process';`
Remove: `checkTmuxAccess()` function
Remove: `checkProviderCli()` function
Remove: `providerToBinary()` function
Remove: the `checks.tmuxAccess` and `checks.providerCli` keys
Remove: the `tmuxAccess` and `providerCli` sections from the console output

Add: `checkApiKey(provider)` function that returns `{ ok, detail }`:

```js
function checkApiKey(provider) {
  const envVarMap = {
    claude:  'ANTHROPIC_API_KEY',
    codex:   'OPENAI_API_KEY',
    gemini:  'GOOGLE_API_KEY',
  };
  const envVar = envVarMap[provider];
  if (!envVar) return { ok: false, detail: `Unknown provider: ${provider}` };
  const present = Boolean(process.env[envVar]);
  return {
    ok: present,
    detail: present ? '' : `${envVar} environment variable is not set`,
    env_var: envVar,
  };
}
```

Update `checks` object:

```js
const checks = {
  providerApiKeys: {},       // replaces providerCli + tmuxAccess
  staleLinkedWorkers: [],
  orphanedActiveClaims: [],
  staleActiveClaims: [],
};

for (const provider of providers) {
  checks.providerApiKeys[provider] = checkApiKey(provider);
}
```

Update `summary.ok`:

```js
const summary = {
  ok:
    Object.values(checks.providerApiKeys).every((c) => c.ok) &&
    checks.staleLinkedWorkers.length === 0 &&
    checks.orphanedActiveClaims.length === 0 &&
    checks.staleActiveClaims.length === 0,
  registered_workers: agents.length,
  active_claims: claims.filter((c) => ['claimed', 'in_progress'].includes(c.state)).length,
  checks,
};
```

Update the console output section — replace tmux and providerCli blocks with:

```js
console.log('provider API keys');
if (Object.keys(checks.providerApiKeys).length === 0) {
  console.log('  (no registered providers)');
} else {
  for (const [provider, result] of Object.entries(checks.providerApiKeys)) {
    console.log(`  ${provider}: ok=${result.ok} env_var=${result.env_var}`);
    if (!result.ok && result.detail) console.log(`    detail: ${result.detail}`);
  }
}
```

Update suggested fixes to remove tmux-era commands:

```js
console.log('Suggested fixes:');
console.log('  1. Set required API key env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY)');
console.log('  2. npm run orc:worker:clearall');
console.log('  3. npm run orc:runs:active -- --json');
console.log('  4. npm run orc:status -- --json');
```

Also update the hint strings in `staleActiveClaims` — remove the `npm run orc:progress`
shell command suggestions (they are no longer applicable for API workers):

```js
hint: claim.state === 'claimed'
  ? `Worker ${claim.agent_id} has not acknowledged run_started for ${Math.round(idleMs / 1000)}s. Check coordinator logs.`
  : `Worker ${claim.agent_id} has not emitted progress for ${Math.round(idleMs / 1000)}s. Check coordinator logs.`,
```

### Step 2 — Update `cli/preflight.mjs`

**File:** `cli/preflight.mjs`

Find and update the suggested actions section (currently prints tmux-era commands):

```js
// BEFORE:
console.log('  1. npm run orc:doctor');
console.log('  2. npm run orc:worker:clearall');

// AFTER:
console.log('  1. npm run orc:doctor  (check API keys and worker state)');
console.log('  2. npm run orc:worker:clearall  (remove stale workers)');
```

No logic changes — hint text only.

### Step 3 — Update `cli/start-worker-session.mjs`

**File:** `cli/start-worker-session.mjs`

Remove:
- `const nestedTmux = Boolean(process.env.TMUX);`
- `const forceAttach = process.argv.includes('--attach');`
- `tmuxSessionForWorker()` function
- The `tmux_session` and `launch_cmd` config keys passed to `adapter.start()`
- The `shouldAttach` / `adapter.attach()` block at the end
- Auto-attach console message referring to tmux

Keep:
- Worker registration (`registerAgent`)
- Session initialization (`adapter.start()` + `adapter.send()` bootstrap)
- `updateAgentRuntime()` call
- `--no-attach` flag (becomes a no-op but may still be passed by scripts)

Replace `adapter.start()` call:

```js
const { session_handle, provider_ref } = await adapter.start(worker.agent_id, {
  system_prompt: buildSessionBootstrap(worker.agent_id, worker.provider, worker.role),
});
```

Note: `buildSessionBootstrap` is imported from `../lib/sessionBootstrap.mjs` (already
imported). In API mode, the bootstrap is the system prompt — no separate `send()` call.

Remove the auto-attach block at the end; replace with:

```js
console.log(`Session ready for ${worker.agent_id}: ${session_handle}`);
console.log(`Use: npm run orc:attach -- ${worker.agent_id}  (prints last response)`);
```

Update the usage string:

```js
console.error('Usage: orc-worker-start-session <worker_id> --provider=<codex|claude|gemini> [--role=<worker|reviewer|master>] [--force-rebind] [--no-attach]');
```

### Step 4 — Update `cli/attach.mjs`

**File:** `cli/attach.mjs`

Replace the log message line:

```js
// BEFORE:
console.error(`Attaching to ${agentId} via ${agent.provider} (${agent.session_handle}) …`);
adapter.attach(agent.session_handle);

// AFTER:
console.error(`Fetching last response for ${agentId} via ${agent.provider} …`);
adapter.attach(agent.session_handle);
```

No logic changes — `adapter.attach()` is now the "print last response" behavior.

### Step 5 — Update JSDoc comments in `gc-workers.mjs` and `clear-workers.mjs`

**File:** `cli/gc-workers.mjs`

Update the JSDoc comment at the top (no code changes):

```js
/**
 * cli/gc-workers.mjs
 * Usage: node cli/gc-workers.mjs [--deregister]
 *
 * Checks registered workers with a session_handle and marks unreachable ones
 * offline. With --deregister, removes unreachable workers from agents.json.
 * Uses adapter.heartbeatProbe() — works with any adapter (API or tmux).
 */
```

**File:** `cli/clear-workers.mjs`

Update the JSDoc comment:

```js
/**
 * cli/clear-workers.mjs
 * Usage: node cli/clear-workers.mjs
 *
 * Removes workers that are definitely stale (offline status or dead heartbeat).
 * Uses adapter.heartbeatProbe() — works with any adapter (API or tmux).
 */
```

### Step 6 — Update `cli/doctor.test.mjs`

**File:** `cli/doctor.test.mjs`

Update existing tests that check for `tmuxAccess` or `providerCli` keys in the JSON
output. Replace with expectations for `providerApiKeys`:

```js
it('reports providerApiKeys for each registered agent provider', () => {
  // Seed agents.json with a claude worker
  // Run: node cli/doctor.mjs --json with ANTHROPIC_API_KEY unset
  const result = runCli(['--json']);
  const json = JSON.parse(result.stdout);
  expect(json.checks).toHaveProperty('providerApiKeys');
  expect(json.checks.providerApiKeys).toHaveProperty('claude');
  expect(json.checks.providerApiKeys.claude.ok).toBe(false);
  expect(json.checks.providerApiKeys.claude.env_var).toBe('ANTHROPIC_API_KEY');
});

it('sets ok=true when API key env var is present', () => {
  const result = runCli(['--json'], { env: { ...process.env, ANTHROPIC_API_KEY: 'test-key' } });
  const json = JSON.parse(result.stdout);
  expect(json.checks.providerApiKeys.claude.ok).toBe(true);
});

it('does not include tmuxAccess in output', () => {
  const result = runCli(['--json']);
  const json = JSON.parse(result.stdout);
  expect(json.checks).not.toHaveProperty('tmuxAccess');
  expect(json.checks).not.toHaveProperty('providerCli');
});
```

---

## Acceptance criteria

- [ ] `doctor.mjs` contains no `spawnSync` import and no tmux shell calls
- [ ] `doctor.mjs --json` output has `checks.providerApiKeys` key, not `checks.tmuxAccess`
- [ ] `doctor.mjs` reports `ok: false` with descriptive detail when API key env var absent
- [ ] `doctor.mjs` reports `ok: true` for a provider when its API key env var is present
- [ ] `start-worker-session.mjs` contains no `TMUX` env var references and no `tmux_session` config key
- [ ] `start-worker-session.mjs` passes `system_prompt` to `adapter.start()`
- [ ] `attach.mjs` log message does not mention tmux
- [ ] `grep -rn "spawnSync.*tmux\|'tmux'" cli/` → no matches
- [ ] All existing CLI tests pass (adjust doctor and preflight tests as needed)
- [ ] Full test suite passes

---

## Tests

**`cli/doctor.test.mjs`** — update existing tests + add 3 new tests as shown
in Step 6.

Run targeted:

```bash
nvm use 22 && npm run test:orc -- doctor
nvm use 22 && npm run test:orc -- preflight
```

---

## Verification

```bash
nvm use 22 && npm run test:orc

# Verify no tmux shell calls in CLI tools
grep -rn "spawnSync.*tmux\|'tmux'" cli/
# Expected: no output

# Verify doctor output shape (requires seeded state dir)
ORCH_STATE_DIR=/tmp/orc-test-$$ node cli/doctor.mjs --json 2>/dev/null || true
# Expected: JSON with checks.providerApiKeys key present

# Verify attach does not hang
echo "" | ORCH_STATE_DIR=/tmp/orc-test node cli/attach.mjs nonexistent-agent 2>&1 || true
# Expected: "Agent not found" error, not a hang
```

## Risk / Rollback

**Risk:** Scripts or CI pipelines that pass `--attach` or `--no-attach` to
`start-worker-session` will still work — both flags are accepted but `--attach` is now
a no-op (no interactive terminal attachment happens).

**Risk:** Operators monitoring `doctor.mjs` output in JSON mode will see `providerApiKeys`
instead of `tmuxAccess` + `providerCli`. Any dashboards/scripts parsing the JSON output
need updating.

**Rollback:** `git checkout cli/` restores all CLI tools. No state files
are modified by this task.
