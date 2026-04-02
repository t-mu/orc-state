---
ref: publish/103-unified-orc-install
feature: publish
priority: high
status: done
depends_on:
  - publish/101-extract-install-shared-logic
  - publish/102-mcp-config-merge-utility
---

# Task 103 — Create Unified `orc install` Command

Depends on Task 101 (exported install functions) and Task 102 (MCP merge utility).

## Scope

**In scope:**
- Create `cli/install.ts` — unified non-interactive installer
- Export a `runInstall(options)` function for programmatic use by `cli/init.ts` (Task 104)
- Install skills, agents, and MCP config in one command
- Autodetect provider(s) from `orchestrator.config.json` when `--provider` not passed
- Register `install` in the CLI dispatcher (`cli/orc.ts`)
- Add to BLESSED commands list
- Add `agents` to `package.json` `files` array (currently missing — install-agents would fail for published consumers)
- Idempotent — safe to re-run (overwrites same-name files with new versions)
- Add tests

**Out of scope:**
- Interactive prompts (that's Task 104 — `orc init` enhancement)
- Adding Gemini provider support to skill/agent installation
- Modifying existing `install-skills` / `install-agents` commands (they continue to work)
- Changing the MCP server itself

---

## Context

Consumers currently need to run `orc install-skills`, `orc install-agents`, and manually configure `.mcp.json` separately. A single `orc install` command simplifies setup and version upgrades.

### Current state

- `orc install-skills` and `orc install-agents` exist as separate commands
- No unified installer
- No MCP config merge during installation
- No provider autodetection from config file

### Desired state

- `orc install` installs skills + agents + MCP config in one shot
- Provider(s) autodetected from `orchestrator.config.json` if `--provider` not passed
- Idempotent: re-running after a version upgrade flashes old files with new

### Start here

- `cli/install-skills.ts` — exported `installSkills()` (from Task 101)
- `cli/install-agents.ts` — exported `installAgents()` (from Task 101)
- `lib/mcpConfig.ts` — `mergeMcpConfig()` (from Task 102)
- `cli/orc.ts` — dispatcher to register the new command

**Affected files:**
- `cli/install.ts` — new file
- `cli/orc.ts` — add `install` to COMMANDS and BLESSED
- `cli/install.test.ts` — new test file
- `package.json` — add `agents` to `files` array

---

## Goals

1. Must install skills, agents, and MCP config with a single `orc install` command.
2. Must export `runInstall(options)` for programmatic use by `cli/init.ts`.
3. Must autodetect provider(s) from `orchestrator.config.json` when `--provider` is not passed.
4. Must support `--skip-skills`, `--skip-agents`, `--skip-mcp` flags.
5. Must support `--global` and `--dry-run` flags.
6. Must be idempotent — overwrites existing files with current package versions.
7. Must error with a helpful message when provider cannot be determined.
8. Must be registered in the CLI dispatcher as a blessed command.
9. Must add `agents` to `package.json` `files` array so agent specs ship in the package.

---

## Implementation

### Step 1 — Create cli/install.ts

**File:** `cli/install.ts` (new)

```ts
import { installSkills } from './install-skills.ts';
import { installAgents } from './install-agents.ts';
import { mergeMcpConfig } from '../lib/mcpConfig.ts';

export interface InstallOptions {
  providers: string[];
  base: string;
  dryRun: boolean;
  skipSkills: boolean;
  skipAgents: boolean;
  skipMcp: boolean;
}

// Exported for programmatic use by cli/init.ts (Task 104)
export async function runInstall(options: InstallOptions): Promise<void> {
  // 1. If not skipSkills: installSkills(providers, base, dryRun)
  // 2. If not skipAgents: installAgents(providers, base, dryRun)
  // 3. If not skipMcp: mergeMcpConfig(base, serverPath, stateDir, dryRun)
  // 4. Print summary
}

// CLI entry point:
// 1. Parse flags: --provider, --global, --dry-run, --skip-skills, --skip-agents, --skip-mcp
// 2. If no --provider, autodetect from orchestrator.config.json
// 3. Call runInstall(options)
```

### Step 2 — Provider autodetection

**File:** `cli/install.ts`

```ts
function detectProviders(base: string): string[] {
  const configPath = join(base, 'orchestrator.config.json');
  if (!existsSync(configPath)) return [];
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const providers = new Set<string>();
  if (config.default_provider) providers.add(config.default_provider);
  if (config.master?.provider) providers.add(config.master.provider);
  if (config.worker_pool?.provider) providers.add(config.worker_pool.provider);
  return [...providers];
}
```

### Step 3 — Register in CLI dispatcher

**File:** `cli/orc.ts`

Add to COMMANDS:
```ts
'install': 'install.ts',
```

Add `'install'` to the BLESSED array.

### Step 4 — Add tests

**File:** `cli/install.test.ts` (new)

- Test: installs skills + agents + MCP for a single provider
- Test: `--skip-mcp` skips MCP merge
- Test: `--skip-skills` skips skill installation
- Test: `--dry-run` makes no file changes
- Test: autodetects provider from orchestrator.config.json
- Test: errors when no provider can be determined

---

## Acceptance criteria

- [ ] `orc install --provider=claude` installs skills, agents, and MCP config.
- [ ] `orc install` without `--provider` reads from `orchestrator.config.json`.
- [ ] `orc install` errors with helpful message when no provider found.
- [ ] `--skip-skills`, `--skip-agents`, `--skip-mcp` each skip their respective step.
- [ ] `--dry-run` prints what would happen without writing files.
- [ ] `--global` installs to home directory.
- [ ] Re-running `orc install` overwrites existing files with current versions.
- [ ] `install` appears in `orc --help` under blessed commands.
- [ ] All tests pass.
- [ ] `npm test` passes.
- [ ] `agents` is in the `package.json` `files` array.
- [ ] `runInstall` is exported from `cli/install.ts`.
- [ ] No changes to files outside `cli/install.ts`, `cli/install.test.ts`, `cli/orc.ts`, and `package.json`.

---

## Tests

Add to `cli/install.test.ts`:

```ts
it('installs skills, agents, and MCP config for a provider');
it('skips MCP when --skip-mcp is passed');
it('skips skills when --skip-skills is passed');
it('dry-run makes no file changes');
it('autodetects provider from orchestrator.config.json');
it('errors when no provider can be determined');
```

---

## Verification

```bash
# Verify command is registered
node cli/orc.ts --help | grep install

# Verify dry-run
node cli/orc.ts install --provider=claude --dry-run

# Full suite
nvm use 24 && npm test
```
