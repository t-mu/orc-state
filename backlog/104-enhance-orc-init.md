---
ref: publish/104-enhance-orc-init
feature: publish
priority: normal
status: todo
depends_on:
  - publish/103-unified-orc-install
---

# Task 104 — Enhance `orc init` with Interactive Setup

Depends on Task 103 (unified `orc install` must exist).

## Scope

**In scope:**
- Add interactive provider selection prompts to `cli/init.ts` (using `@inquirer/prompts`)
- Add checkbox prompts for skills, agents, and MCP installation
- Generate `orchestrator.config.json` with selected provider(s)
- Call `orc install` (or import the function) with selected options
- Make idempotent: skip state file creation if they exist, re-run install to update
- Non-TTY fallback with flags
- Update `docs/getting-started.md` and `docs/cli.md`

**Out of scope:**
- Changing the state initialization logic (`ensureStateInitialized`)
- Modifying the unified `orc install` command
- Adding new provider support

---

## Context

`orc init` currently only creates `.orc-state/` with empty state files. Consumers also need skills, agents, MCP config, and `orchestrator.config.json` — requiring multiple manual steps. An enhanced `orc init` should be the single entry point for first-time setup.

### Current state

`cli/init.ts` creates `.orc-state/` directory and state files. It accepts `--feature` and `--force` flags. It does not interact with providers, skills, agents, or MCP configuration. It errors if state files already exist (without `--force`).

### Desired state

`orc init` in a TTY:
1. Prompts for provider(s) with checkboxes
2. Prompts for what to install (skills, agents, MCP — all recommended/default yes)
3. Creates `.orc-state/` if needed (skip if exists)
4. Writes `orchestrator.config.json` with selected provider(s)
5. Runs `orc install` with selected options
6. Prints success summary with next steps

`orc init` without TTY:
- `--provider=claude,codex` required
- `--skip-skills` / `--skip-agents` / `--skip-mcp` for opt-out
- Same behavior as interactive, just flag-driven

### Start here

- `cli/init.ts` — existing implementation to enhance
- `cli/install.ts` — unified installer to call (from Task 103)
- `@inquirer/prompts` — already in dependencies

**Affected files:**
- `cli/init.ts` — enhanced with interactive prompts and install integration
- `docs/getting-started.md` — update install section
- `docs/cli.md` — update `init` description

---

## Goals

1. Must prompt for provider(s) interactively when TTY is available.
2. Must prompt for skills/agents/MCP installation with recommended defaults.
3. Must generate `orchestrator.config.json` with selected provider configuration.
4. Must call the unified install logic with selected options.
5. Must be idempotent: safe to re-run without `--force`, skips existing state files, re-runs install.
6. Must work non-interactively with `--provider` flag in non-TTY environments.
7. Must update docs to reflect `orc init` as the recommended first-time setup.

---

## Implementation

### Step 1 — Add interactive prompts

**File:** `cli/init.ts`

When TTY is detected and `--provider` is not passed:

```ts
import { checkbox, confirm } from '@inquirer/prompts';

const providers = await checkbox({
  message: 'Which provider(s) will you use?',
  choices: [
    { name: 'Claude', value: 'claude', checked: true },
    { name: 'Codex', value: 'codex', checked: true },
    { name: 'Gemini', value: 'gemini', checked: false },
  ],
});

const installSkills = await confirm({ message: 'Install skills? (recommended)', default: true });
const installAgents = await confirm({ message: 'Install agents? (recommended)', default: true });
const installMcp = await confirm({ message: 'Configure MCP? (recommended)', default: true });
```

### Step 2 — Generate orchestrator.config.json

**File:** `cli/init.ts`

After provider selection, write config:

```ts
const config: Record<string, unknown> = {};
if (providers.length === 1) {
  config.default_provider = providers[0];
} else if (providers.length > 1) {
  config.default_provider = providers[0]; // first selected as default
  config.worker_pool = { provider: providers[1] }; // second as worker default
}
writeFileSync('orchestrator.config.json', JSON.stringify(config, null, 2));
```

### Step 3 — Make state creation idempotent

**File:** `cli/init.ts`

Replace the current "error if exists" behavior:
- If `.orc-state/` exists and `--force` is not passed: skip state creation, print "State directory already exists, skipping"
- Always proceed to install step

### Step 4 — Call unified install

**File:** `cli/init.ts`

Import and call the install logic from `cli/install.ts`:

```ts
import { runInstall } from './install.ts';

await runInstall({
  providers,
  base: process.cwd(),
  dryRun: false,
  skipSkills: !installSkills,
  skipAgents: !installAgents,
  skipMcp: !installMcp,
});
```

### Step 5 — Update docs

**File:** `docs/getting-started.md`

Update the install section:

```markdown
## Getting started

```bash
npm install -g orc-state
cd my-project
orc init
```

The `init` command walks you through provider selection and installs
skills, agents, and MCP configuration.
```

**File:** `docs/cli.md`

Update `init` description:
```
| `init` | Interactive first-time setup: provider selection, state initialization, skills/agents/MCP installation. |
```

---

## Acceptance criteria

- [ ] `orc init` in a TTY prompts for providers, skills, agents, MCP.
- [ ] `orc init --provider=claude` works non-interactively.
- [ ] `orchestrator.config.json` is created with selected provider(s).
- [ ] State directory creation is skipped if it already exists (no error).
- [ ] Skills, agents, and MCP are installed based on user selections.
- [ ] Re-running `orc init` updates install artifacts without errors.
- [ ] `docs/getting-started.md` recommends `orc init` as first-time setup.
- [ ] `docs/cli.md` has updated `init` description.
- [ ] `npm test` passes.
- [ ] No changes to files outside `cli/init.ts`, `docs/getting-started.md`, `docs/cli.md`.

---

## Tests

Update `cli/init.test.ts`:

```ts
it('creates orchestrator.config.json with selected provider');
it('skips state creation when .orc-state already exists');
it('calls install with selected options');
it('works non-interactively with --provider flag');
```

---

## Verification

```bash
# Verify interactive mode (manual)
node cli/orc.ts init

# Verify non-interactive mode
node cli/orc.ts init --provider=claude --skip-agents

# Full suite
nvm use 24 && npm test
```
