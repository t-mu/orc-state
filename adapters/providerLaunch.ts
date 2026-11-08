/**
 * adapters/providerLaunch.ts
 *
 * Everything a provider CLI launch needs before it runs in a terminal: the
 * binary, args, env and cwd (including the Claude settings/hooks file and the
 * sandbox grants), the startup-dialog keystrokes, and blocking-prompt
 * detection over terminal text. The tmux adapter (adapters/tmux.ts) runs the
 * launch; the Codex app-server reuses the sandbox and MCP-isolation helpers.
 *
 * State written to STATE_DIR:
 *   pty-settings/{agentId}.json — Claude settings (hooks, sandbox) per session
 *   (pty-logs/ and pty-hook-events/ are created here and written by the
 *   session and its hooks; the directory names predate the tmux-only runtime.)
 *
 * Provider → CLI binary:
 *   claude → claude
 *   codex  → codex
 *   gemini → gemini
 */
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { STATE_DIR, TARGET_REPO_ROOT, hookEventPath } from '../lib/paths.ts';
import { resolveOrcBin, shellEscape } from '../lib/orcBin.ts';
import { stripNestedProviderEnv } from '../lib/providerChildEnv.ts';
import type { SandboxNetwork } from '../lib/providers.ts';
import { OPERATOR_TOKEN_FILE } from '../lib/controlProtocol.ts';
import { taskLabelsPath } from '../hooks/orc-hook.ts';
import { fileURLToPath } from 'node:url';

const PROVIDER_BINARIES: Record<string, string> = {
  claude: 'claude',
  codex:  'codex',
  gemini: 'gemini',
};

/** The shipped Claude hook script (compiled to dist/hooks/orc-hook.js by the build). */
const CLAUDE_HOOK_SCRIPT = fileURLToPath(new URL('../hooks/orc-hook.ts', import.meta.url));
/** PreToolUse matcher for the to-do tools whose current item labels a run. */
export const CLAUDE_TODO_TOOL_MATCHER = 'TodoWrite|TaskCreate|TaskUpdate';

/** Shell command for one Claude hook: `node <script> <kind> <events-file>`. */
export function claudeHookCommand(kind: string, eventsFile: string): string {
  return `node ${JSON.stringify(CLAUDE_HOOK_SCRIPT)} ${kind} ${JSON.stringify(eventsFile)}`;
}

const STARTUP_DELAY_MS   = 1500;     // wait for CLI to initialise before sending bootstrap
const BYPASS_SETTLE_MS   = 800;      // wait after bypass-accept for dialog to dismiss
const CODEX_PROMPT_WAIT_MS = Number.parseInt(process.env.ORC_CODEX_PROMPT_WAIT_MS ?? '10000', 10);  // smoke harness override for Codex trust/workspace prompt polling
const CODEX_PROMPT_POLL_MS = 250;
// Prompt-scan patterns must be narrow to avoid false positives from diagnostic text,
// echoed instructions, or tool output that merely mentions permission concepts.
// Only match lines that look like actual interactive confirmation prompts.
//
// Both bracket forms are accepted: [y/n]/[yes/no] and (y/n)/(yes/no).
const BLOCKING_PROMPT_PATTERNS = [
  // Verb-led interactive prompts — matches action verbs followed by any text
  // and a choice indicator. Handles prompts without a trailing question mark
  // (e.g. "Would you like to proceed [y/n]", "Allow access? (yes/no)").
  /\b(?:would you like|apply|approve|allow|grant|permit|continue|proceed|confirm|run|execute)[^\n]*[\[(](?:y\/n|yes\/no)[\])]/i,
  // Generic question prompt — any line where a question mark is immediately
  // followed by a choice indicator (e.g. "Overwrite file? [y/n]", "Continue? (yes/no)").
  /[^\n]+\?\s*[\[(](?:y\/n|yes\/no)[\])]/i,
];

/** Claude's limit for the Stop hook; `orc stop-check` gives up on the coordinator well before it. */
const STOP_HOOK_TIMEOUT_S = 15;

function settingsPath(agentId: string) { return join(STATE_DIR, 'pty-settings', `${agentId}.json`); }

function ensureDirs() {
  mkdirSync(join(STATE_DIR, 'pty-logs'), { recursive: true });
  mkdirSync(join(STATE_DIR, 'pty-hook-events'), { recursive: true });
  mkdirSync(join(STATE_DIR, 'pty-settings'), { recursive: true });
}

/**
 * Subpaths under `<target>/.git` that a sandboxed worker legitimately writes
 * during commit / rebase / fetch inside its linked worktree. Verified
 * empirically against real git — a worktree commit, a conflicted rebase, and a
 * fetch all write only within these four subtrees:
 *
 *   objects/    new blobs, trees, commits, and packs
 *   refs/       the worker's own branch ref plus remote-tracking refs
 *   logs/       reflogs for those refs
 *   worktrees/  per-worktree transient state (HEAD, index, ORIG_HEAD,
 *               COMMIT_EDITMSG, MERGE_MSG, REBASE_HEAD, rebase-merge/*,
 *               FETCH_HEAD)
 *
 * The grant deliberately EXCLUDES `hooks/` and `config`: a sandboxed worker
 * must not be able to plant a hook script or rewrite git config (e.g.
 * core.hooksPath / core.fsmonitor / an alias) that the UNSANDBOXED coordinator
 * would later execute during merge / push / worktree operations — a
 * privilege-escalation vector. `packed-refs` is also excluded; the worker only
 * ever creates loose refs, and auto-gc ref-packing failures are non-fatal.
 */
const TARGET_GIT_WRITABLE_SUBPATHS = ['objects', 'refs', 'logs', 'worktrees'];

function targetGitWritableRoots(targetRepoRoot: string): string[] {
  const gitDir = join(targetRepoRoot, '.git');
  return TARGET_GIT_WRITABLE_SUBPATHS.map((sub) => join(gitDir, sub));
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export interface SandboxRootsOptions {
  readOnly: boolean;
  /** The provider's launch cwd — the assigned worktree for task workers. */
  cwd: string;
  /** The project state dir; a session never writes it (it holds the operator token the session must not read). */
  stateDir: string;
  /** Repo whose `.git` backs the worktree: the registered target repo. */
  gitRepoRoot: string;
  /** The coordinator's control socket the worker may connect to. */
  controlSocket?: string | null;
}

/**
 * Writable roots a sandboxed worker needs beyond its launch cwd (tasks 190,
 * 193, 204).
 *
 * Workers launch in their assigned worktree, so the sandbox's own cwd grant
 * covers the worktree's files. Two things the worker legitimately writes live
 * outside it:
 *
 *   - its lifecycle requests, which it sends to the coordinator (Task 229):
 *     it gets only the control socket, never the state dir, so it cannot
 *     write the project's SQLite or claims;
 *   - the backing repo's `.git` — a linked worktree shares its main repo's
 *     object store, refs and per-worktree state, so commits and rebases write
 *     there; the backing repo is the project's registered target repo.
 *     We grant only TARGET_GIT_WRITABLE_SUBPATHS — never `.git` wholesale, so
 *     the worker cannot write `hooks/` or `config`.
 *
 * Roots already inside the cwd are dropped (e.g. a scout launched at the
 * orchestration root). Read-only (scouts) get no writable roots at all.
 */
/** The control socket a session was given (blank or absent when it has none, e.g. in a unit test). */
export function controlSocketOf(config: Record<string, unknown>): string | null {
  return (config.env as Record<string, string> | undefined)?.ORC_CONTROL_SOCKET || null;
}

export function sandboxExtraWritableRoots(opts: SandboxRootsOptions): string[] {
  if (opts.readOnly) return [];
  // A worker reaches its state only through the socket itself.
  const roots = [...(opts.controlSocket ? [opts.controlSocket] : []), ...targetGitWritableRoots(opts.gitRepoRoot)];
  return roots.filter((root) => !isWithin(opts.cwd, root));
}

/**
 * Compute the Claude sandbox filesystem writable roots: `.` (the launch cwd)
 * plus sandboxExtraWritableRoots. Read-only (scouts) get no writable roots.
 */
export function claudeSandboxFilesystem(opts: SandboxRootsOptions): { allowWrite: string[] } | undefined {
  if (opts.readOnly) return undefined;
  return { allowWrite: ['.', ...sandboxExtraWritableRoots(opts)] };
}

/**
 * Extra Codex sandbox args granting sandboxExtraWritableRoots — the Codex
 * counterpart to claudeSandboxFilesystem. Codex workspace-write already covers
 * the launch cwd. Returns [] when nothing beyond the cwd is needed and for
 * read-only scouts.
 *
 * Uses Codex's `-c` config override for `writable_roots`. The value is JSON —
 * a well-formed JSON array is valid input for a Codex `-c` override, and
 * JSON.stringify escapes any special characters in the paths (a raw string
 * interpolation would break on a `"` or `\` in the target path). See
 * docs/configuration.md → Execution Modes → Codex.
 */
export function codexSandboxWritableRootArgs(opts: SandboxRootsOptions): string[] {
  const roots = sandboxExtraWritableRoots(opts);
  if (roots.length === 0) return [];
  return ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`];
}

/** The opt-in `worker_pool.sandbox_network` setting a launch carries (task 230). */
export function sandboxNetworkOf(config: Record<string, unknown>): SandboxNetwork {
  return config.sandbox_network === 'open' ? 'open' : 'restricted';
}

/**
 * Codex sandbox args letting a project worker reach its control socket.
 * `workspace-write` blocks network access, Unix sockets included, and has no
 * per-socket allowance, so only `sandbox_network: open` connects the worker
 * — by giving it network access. Read-only scouts have no network setting.
 * See docs/configuration.md → Execution Modes → Codex.
 */
export function codexSandboxNetworkArgs(opts: SandboxRootsOptions, network: SandboxNetwork): string[] {
  return !opts.readOnly && opts.controlSocket && network === 'open' ? ['-c', 'sandbox_workspace_write.network_access=true'] : [];
}

/**
 * Claude sandbox network settings for a project session's control socket.
 * Connecting to a Unix socket is a network permission in Claude's sandbox.
 * `allowUnixSockets` names the path, which only macOS honours; Linux ignores
 * it (seccomp cannot filter by path), so there the socket is reachable only
 * with `sandbox_network: open`, which allows every Unix socket.
 */
export function claudeSandboxNetwork(controlSocket: string, network: SandboxNetwork, platform: NodeJS.Platform = process.platform): Record<string, unknown> {
  return { allowUnixSockets: [controlSocket], ...(network === 'open' && platform === 'linux' ? { allowAllUnixSockets: true } : {}) };
}

/**
 * Resolve the provider launch cwd (task 204). An explicit working_directory —
 * the assigned worktree for task workers — is used as-is and must be an
 * existing directory; launching elsewhere would silently run the worker
 * against the wrong checkout. With `require_git_checkout` (set for task
 * workers) it must also be a git checkout, so a half-removed worktree fails at
 * launch instead of at the worker's first commit, and it must be present.
 * Otherwise (scouts, tests) a missing working_directory falls back to the
 * target repository.
 */
export function resolveLaunchCwd(config: Record<string, unknown>): string {
  const workingDirectory = typeof config.working_directory === 'string' && config.working_directory
    ? config.working_directory
    : null;
  if (workingDirectory == null) {
    // A task worker must never fall back to the target repository: it would
    // run against the main checkout with a whole-root sandbox grant.
    if (config.require_git_checkout === true) throw new Error('worker launch requires an assigned worktree; none recorded');
    return TARGET_REPO_ROOT;
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(workingDirectory).isDirectory();
  } catch {
    throw new Error(`assigned working directory does not exist: ${workingDirectory}`);
  }
  if (!isDirectory) throw new Error(`assigned working directory is not a directory: ${workingDirectory}`);
  if (config.require_git_checkout === true && !existsSync(join(workingDirectory, '.git'))) {
    throw new Error(`assigned working directory is not a git worktree: ${workingDirectory}`);
  }
  return resolve(workingDirectory);
}

function sandboxRootsOptions(config: Record<string, unknown>, cwd: string): SandboxRootsOptions {
  return {
    readOnly: config.read_only === true,
    cwd,
    stateDir: STATE_DIR,
    gitRepoRoot: TARGET_REPO_ROOT,
    controlSocket: controlSocketOf(config),
  };
}

/**
 * Workers and scouts never start the master's orchestrator MCP server: the
 * repository's `.mcp.json`, `.codex/config.toml` or `.gemini/settings.json`
 * would otherwise start it inside them, with tools that do not check who calls
 * them. They reach the orchestrator through the `orc` CLI only. Claude and
 * Gemini start no MCP servers at all; Codex disables the orchestrator server.
 */
/** The name `orc install` and the master's MCP config give the orchestrator server (lib/mcpConfig.ts). */
const ORC_MCP_SERVER_NAME = 'orchestrator';

export function isolatedMcpArgs(provider: string): string[] {
  if (provider === 'claude') return ['--strict-mcp-config'];
  // Codex merges `-c` tables into its config, so `mcp_servers={}` removes nothing; disable orc's own
  // server by name instead (a full table, so it also parses where no such server is configured).
  if (provider === 'codex') return ['-c', `mcp_servers.${ORC_MCP_SERVER_NAME}={command="true",enabled=false}`];
  // Gemini starts only the named servers; no server has this name.
  if (provider === 'gemini') return ['--allowed-mcp-server-names', 'orc-no-mcp-servers'];
  return [];
}

function stringConfig(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  return typeof value === 'string' && value ? value : null;
}

function buildStartArgs(provider: string, config: Record<string, unknown>, cwd: string, claudeSettingsPath?: string) {
  // Mirrors ExecutionMode from lib/providers.ts (added by task 117). Default is
  // 'full-access' for backward compatibility when field is absent.
  const executionMode = typeof config.execution_mode === 'string' ? config.execution_mode : 'full-access';
  const readOnly = config.read_only === true;

  if (provider === 'codex') {
    const args: string[] = [];
    if (executionMode === 'sandbox') {
      // sandbox + read_only (scouts) → read-only filesystem; otherwise workspace-write.
      // workspace-write scopes writes to the launch cwd (the assigned
      // worktree); the state dir and the backing repo's .git write subtrees
      // are granted as additional writable roots (see sandboxExtraWritableRoots).
      const sandboxScope = readOnly ? 'read-only' : 'workspace-write';
      args.push('--sandbox', sandboxScope, '--ask-for-approval', 'never');
      const rootsOptions = sandboxRootsOptions(config, cwd);
      args.push(...codexSandboxWritableRootArgs(rootsOptions), ...codexSandboxNetworkArgs(rootsOptions, sandboxNetworkOf(config)));
    } else {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    // Enable multi-agent support so Codex workers can spawn sub-agent reviewers.
    args.push('--enable', 'multi_agent', ...isolatedMcpArgs('codex'));
    if (typeof config.model === 'string' && config.model) args.push('--model', config.model);
    if (typeof config.system_prompt === 'string' && config.system_prompt) args.push(config.system_prompt);
    return args;
  }
  if (provider === 'claude') {
    const args: string[] = [];
    if (executionMode === 'sandbox') {
      // Sandbox mode: use permission-mode auto instead of dangerously-skip-permissions.
      args.push('--permission-mode', 'auto');
    } else {
      // Skip interactive permission prompts so workers can run bash commands
      // without blocking on "Do you want to proceed?" confirmations.
      args.push('--dangerously-skip-permissions');
    }
    if (claudeSettingsPath) args.push('--settings', claudeSettingsPath);
    // The conversation id is chosen by orc so a crashed session can be resumed in place.
    const resumeId = stringConfig(config, 'resume_conversation_id');
    const conversationId = stringConfig(config, 'conversation_id');
    if (resumeId) args.push('--resume', resumeId);
    else if (conversationId) args.push('--session-id', conversationId);
    args.push(...isolatedMcpArgs('claude'));
    if (typeof config.model === 'string' && config.model) args.push('--model', config.model);
    return args;
  }
  return [...isolatedMcpArgs(provider), ...(typeof config.model === 'string' && config.model ? ['--model', config.model] : [])];
}

export interface ProviderLaunch {
  binary: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/** Resolve binary, args, env and cwd for a provider CLI; writes the Claude settings file. */
export function prepareProviderLaunch(provider: string, agentId: string, config: Record<string, unknown>): ProviderLaunch {
  ensureDirs();
  const binary = PROVIDER_BINARIES[provider] ?? provider;
  // Workers start in their assigned worktree (task 204); ORC_PROJECT_ID and the
  // ORC_STATE_DIR bridge in the worker env keep `orc` state lookup on the project.
  const cwd = resolveLaunchCwd(config);
  // For claude: write a settings file whose hooks push harness events to the
  // agent's hook-events NDJSON file (drained by the coordinator):
  //   SessionStart            → `session_start` record: the session's readiness signal (lib/sessionStartReadiness.ts)
  //   Notification            → permission_prompt records (input-block detection)
  //   PostToolUse  `*`        → `tool` records with a short brief
  //   PostToolUseFailure `*`  → the same `tool` record for a failed call (closes its tool_start)
  //   PreToolUse   `*`        → `tool_start` records (a tool call in flight is not idleness)
  //   PreToolUse   to-do tools → `activity` records with the current to-do label
  //   (the four tool hooks above: task workers only; a read-only scout gets just SessionStart and Notification)
  //   Stop (task workers only) → `orc stop-check` asks the coordinator (not the events file)
  // In sandbox mode, merge in a sandbox config block alongside the hooks.
  let claudeSettingsFile: string | undefined;
  if (provider === 'claude') {
    claudeSettingsFile = settingsPath(agentId);
    const eventsFile = hookEventPath(agentId);
    // Task labels remembered by the hook belong to one session; start clean.
    try { unlinkSync(taskLabelsPath(eventsFile)); } catch { /* never created */ }
    const hook = (kind: string) => ({ type: 'command', command: claudeHookCommand(kind, eventsFile) });
    const executionMode = typeof config.execution_mode === 'string' ? config.execution_mode : 'full-access';
    const hooks: Record<string, unknown> = {
      SessionStart: [{ hooks: [hook('session_start')] }],
      Notification: [{ hooks: [hook('permission')] }],
    };
    // Task workers only (a scout ends after its report; the master is not launched here). Tool
    // hooks feed run activity, which the coordinator drains only for a claimed run, so a read-only
    // scout gets none. The Stop hook asks the coordinator whether the run lets the session end its
    // turn (lib/stopCheck.ts).
    if (config.read_only !== true) {
      hooks.PostToolUse = [{ matcher: '*', hooks: [hook('tool')] }];
      hooks.PostToolUseFailure = [{ matcher: '*', hooks: [hook('tool')] }];
      hooks.PreToolUse = [{ matcher: '*', hooks: [hook('tool_start')] }, { matcher: CLAUDE_TODO_TOOL_MATCHER, hooks: [hook('todo')] }];
      const orcBin = resolveOrcBin(null, { ...process.env, ...(config.env as Record<string, string> | undefined ?? {}) });
      hooks.Stop = [{ hooks: [{ type: 'command', command: `${shellEscape(orcBin)} stop-check`, timeout: STOP_HOOK_TIMEOUT_S }] }];
    }
    const settings: Record<string, unknown> = { hooks };
    if (executionMode === 'sandbox') {
      const sandboxConfig: Record<string, unknown> = {
        enabled: true,
        mode: 'auto-allow',
        allowUnsandboxedCommands: false,
      };
      const rootsOptions = sandboxRootsOptions(config, cwd);
      const filesystem = claudeSandboxFilesystem(rootsOptions);
      // A session must not read the operator's credential (task 231): the sandbox
      // hides it from shell commands, a permission rule from the Read tool (`//` marks an absolute path).
      const operatorToken = join(rootsOptions.stateDir, OPERATOR_TOKEN_FILE);
      sandboxConfig.filesystem = { ...(filesystem ?? {}), denyRead: [operatorToken] };
      settings.permissions = { deny: [`Read(/${operatorToken})`] };
      // Read-only scouts need the socket too: their lifecycle commands go through the coordinator.
      if (rootsOptions.controlSocket) {
        sandboxConfig.network = claudeSandboxNetwork(rootsOptions.controlSocket, sandboxNetworkOf(config));
      }
      settings.sandbox = sandboxConfig;
    }
    writeFileSync(claudeSettingsFile, JSON.stringify(settings));
  }

  const spawnArgs = buildStartArgs(provider, config, cwd, claudeSettingsFile);

  // Strip parent provider/session control env vars so nested worker
  // sessions start cleanly instead of inheriting the parent CLI sandbox
  // or session metadata.
  const baseEnv = stripNestedProviderEnv(process.env);
  const spawnEnv = { ...baseEnv, ...(config.env as Record<string, string> ?? {}) } as Record<string, string>;
  const resolvedBinary = resolveBinary(binary, spawnEnv);
  return {
    binary: resolvedBinary,
    args: spawnArgs,
    env: spawnEnv,
    cwd,
  };
}

/** Dismiss provider startup dialogs, then deliver the bootstrap prompt. */
export async function runStartupDialogs(
  write: (text: string) => void,
  provider: string,
  config: Record<string, unknown>,
  readRecentOutput: () => string,
): Promise<void> {
  // ── Startup dialog handling ───────────────────────────────────────
  // Provider CLIs may show interactive startup dialogs that must be
  // dismissed before they accept work. We send keystrokes after a
  // startup delay to auto-accept these dialogs.
  await new Promise((r) => setTimeout(r, STARTUP_DELAY_MS));

  if (provider === 'codex') {
    // Codex may show a workspace confirmation dialog for new directories:
    //   "You are in /tmp/... 1. Yes, continue  Press enter to continue"
    // The smoke harness uses a prompt-aware path because it launches Codex
    // inside disposable repos where trust/workspace dialogs can appear late.
    // Outside that test-only profile we preserve the existing runtime
    // behavior: send a single Enter after startup delay to dismiss the
    // workspace prompt if present.
    if (shouldUseExtendedCodexPromptWait(config)) {
      const prompt = await waitForCodexWorkspacePrompt(readRecentOutput);
      if (prompt != null) {
        write('\r');
        await new Promise((r) => setTimeout(r, BYPASS_SETTLE_MS));
      }
    } else {
      write('\r');
      await new Promise((r) => setTimeout(r, BYPASS_SETTLE_MS));
    }
  } else if (provider === 'claude' && config.execution_mode !== 'sandbox') {
    // Claude shows up to two startup dialogs:
    //
    // 1. Workspace trust ("❯ 1. Yes, I trust" / "2. No, exit")
    //    — only for new/untrusted directories. Enter accepts default.
    //
    // 2. Bypass Permissions ("1. No, exit" / "❯ 2. Yes, I accept")
    //    — always with --dangerously-skip-permissions. Select '2'.
    //
    // We send Enter (trust dismiss or bypass accept), then '2' + Enter
    // (explicit bypass accept). When trust is absent, the initial Enter
    // accepts bypass directly and '2' + Enter is absorbed harmlessly.
    write('\r');
    await new Promise((r) => setTimeout(r, BYPASS_SETTLE_MS));
    write('2');
    await new Promise((r) => setTimeout(r, 200));
    write('\r');
    await new Promise((r) => setTimeout(r, BYPASS_SETTLE_MS));
  }

  if (config.system_prompt && typeof config.system_prompt === 'string' && provider !== 'codex') {
    write(config.system_prompt);
    await new Promise((r) => setTimeout(r, provider === 'codex' ? 700 : 500));
    write('\r');
  }
}

export function resolveBinary(binary: string, env: Record<string, string>) {
  if (!binary || binary.includes('/') || isAbsolute(binary)) return binary;
  const searchPath = env.PATH ?? process.env.PATH ?? '';
  for (const dir of searchPath.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return binary;
}

/**
 * Lines that look like diff output, code, or quoted text — not real interactive
 * prompts. Matching these avoids false positives when a worker is viewing a
 * git diff or editing documentation that *mentions* "[y/n]" prompts.
 */
const CONTEXT_LINE_PATTERN = /^(?:[+\-](?!\+\+|\-\-)|\s*@@\s|>\s|#\s|\d+\s*[+\-|])/;

/**
 * Maximum number of trailing non-empty lines to scan for blocking prompts.
 * A real interactive prompt is always at the terminal cursor — nothing follows
 * it. Scanning deeper into the log just increases false-positive risk from
 * diff output, bootstrap text, and documentation that mentions prompts.
 */
const PROMPT_SCAN_RECENCY_LINES = 5;
const CODEX_WORKSPACE_PROMPT_PATTERNS = [
  /press enter to continue/i,
  /\byou are in\b/i,
  /\byes,\s*continue\b/i,
];

export function detectBlockingPromptFromText(text: string) {
  const lines = String(text)
    .split('\n')
    .map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim())
    .filter(Boolean);

  const scanStart = Math.max(0, lines.length - PROMPT_SCAN_RECENCY_LINES);
  for (let index = lines.length - 1; index >= scanStart; index -= 1) {
    const line = lines[index];
    // Skip lines that look like diff output, code, or quoted text.
    if (CONTEXT_LINE_PATTERN.test(line)) continue;
    if (BLOCKING_PROMPT_PATTERNS.some((pattern) => pattern.test(line))) {
      return line;
    }
    if (
      /quota/i.test(line)
      || /token limit/i.test(line)
      || /context (window|limit|length)/i.test(line)
      || /session quota/i.test(line)
      || /rate limit/i.test(line)
      || /try again later/i.test(line)
    ) {
      return line;
    }
  }
  return null;
}

export function detectCodexWorkspacePromptFromText(text: string) {
  const lines = String(text)
    .split('\n')
    .map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim())
    .filter(Boolean);

  const scanStart = Math.max(0, lines.length - PROMPT_SCAN_RECENCY_LINES);
  for (let index = lines.length - 1; index >= scanStart; index -= 1) {
    const line = lines[index];
    if (CODEX_WORKSPACE_PROMPT_PATTERNS.some((pattern) => pattern.test(line))) {
      return line;
    }
  }
  return null;
}

async function waitForCodexWorkspacePrompt(
  readRecentOutput: () => string,
  timeoutMs = CODEX_PROMPT_WAIT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const prompt = detectCodexWorkspacePromptFromText(readRecentOutput());
    if (prompt != null) return prompt;
    await new Promise((r) => setTimeout(r, CODEX_PROMPT_POLL_MS));
  }
  return null;
}

function shouldUseExtendedCodexPromptWait(config: Record<string, unknown>) {
  return config.startup_profile === 'real-provider-smoke';
}

