/**
 * adapters/pty.ts
 *
 * Adapter that drives real CLI agent sessions as PTY child processes.
 * No direct provider credential env vars required. No external session manager required.
 *
 * Session handle format: pty:{agentId}
 *
 * Process ownership: the coordinator is the sole owner of PTY sessions.
 * CLI tools use the PID file fallback for heartbeat checks.
 *
 * State written to STATE_DIR:
 *   pty-pids/{agentId}.pid  — PID for cross-process heartbeat
 *   pty-logs/{agentId}.log  — PTY output (truncated on each start())
 *
 * Provider → CLI binary:
 *   claude → claude
 *   codex  → codex
 *   gemini → gemini
 */
import pty from 'node-pty';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { defaultSocketPath } from '../lib/controlProtocol.ts';
import { STATE_DIR, TARGET_REPO_ROOT, hookEventPath, consumeHookEvents } from '../lib/paths.ts';
import { stripAnsi } from '../lib/ansi.ts';
import { ensureNodePtySpawnHelperPermissions } from '../lib/nodePtyPermissions.ts';
import { stripNestedProviderEnv } from '../lib/providerChildEnv.ts';
import { isPidAlive, isSameProcess, processIdentity } from '../lib/processIdentity.ts';
import type { SessionInspection } from './interface.ts';

const PROVIDER_BINARIES: Record<string, string> = {
  claude: 'claude',
  codex:  'codex',
  gemini: 'gemini',
};

const OUTPUT_TAIL_BYTES  = 8 * 1024; // 8 KB
const RECENT_OUTPUT_BYTES = 16 * 1024;
const STARTUP_DELAY_MS   = 1500;     // wait for CLI to initialise before sending bootstrap
const BYPASS_SETTLE_MS   = 800;      // wait after bypass-accept for dialog to dismiss
const CODEX_PROMPT_WAIT_MS = Number.parseInt(process.env.ORC_CODEX_PROMPT_WAIT_MS ?? '10000', 10);  // smoke harness override for Codex trust/workspace prompt polling
const CODEX_PROMPT_POLL_MS = 250;
// PTY-scan patterns must be narrow to avoid false positives from diagnostic text,
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

ensureNodePtySpawnHelperPermissions();

function pidPath(agentId: string) { return join(STATE_DIR, 'pty-pids', `${agentId}.pid`); }
function logPath(agentId: string) { return join(STATE_DIR, 'pty-logs', `${agentId}.log`); }

/**
 * Sanitize a raw PTY chunk for LLM-readable log files.
 *
 * Two passes:
 * 1. Strip all terminal escape sequences (CSI, OSC, and bare ESC codes).
 * 2. Collapse carriage-return overwrites — TUI spinners write `\r<new frame>`
 *    to overwrite the current line. After stripping escapes we honour those
 *    by keeping only the last segment before each newline.
 */
function sanitizePtyChunk(raw: string): string {
  // Strip CSI sequences: ESC [ ... <final byte>
  // Strip OSC sequences: ESC ] ... (BEL or ST)
  // Strip bare ESC + single char (e.g. ESC M — reverse index)
  const stripped = raw
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')   // CSI
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b[^[\]]/g, '');               // bare ESC + char

  // Collapse \r overwrites: split on \n, keep text after last \r in each line.
  return stripped
    .split('\n')
    .map((line) => {
      const idx = line.lastIndexOf('\r');
      return idx === -1 ? line : line.slice(idx + 1);
    })
    .join('\n');
}

function settingsPath(agentId: string) { return join(STATE_DIR, 'pty-settings', `${agentId}.json`); }

function ensureDirs() {
  mkdirSync(join(STATE_DIR, 'pty-pids'), { recursive: true });
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
  /** Orchestration state dir; `orc` CLI calls from the worker write here. */
  stateDir: string;
  /** Repo whose `.git` backs the worktree (the target repo in sibling layout). */
  gitRepoRoot: string;
}

/**
 * Writable roots a sandboxed worker needs beyond its launch cwd (tasks 190,
 * 193, 204).
 *
 * Workers launch in their assigned worktree, so the sandbox's own cwd grant
 * covers the worktree's files. Two things the worker legitimately writes live
 * outside it:
 *
 *   - the orchestration state dir, written by every `orc` lifecycle call;
 *   - the backing repo's `.git` — a linked worktree shares its main repo's
 *     object store, refs and per-worktree state, so commits and rebases write
 *     there. This holds in BOTH layouts: in the attached layout the backing
 *     repo is the orchestration repo, in the sibling layout the target repo.
 *     We grant only TARGET_GIT_WRITABLE_SUBPATHS — never `.git` wholesale, so
 *     the worker cannot write `hooks/` or `config`.
 *
 * Roots already inside the cwd are dropped (e.g. a scout launched at the
 * orchestration root). Read-only (scouts) get no writable roots at all.
 */
export function sandboxExtraWritableRoots(opts: SandboxRootsOptions): string[] {
  if (opts.readOnly) return [];
  // A long state path puts the control socket in a private per-user directory instead.
  const socketDir = dirname(defaultSocketPath(opts.stateDir));
  const roots = [opts.stateDir, ...(isWithin(opts.stateDir, socketDir) ? [] : [socketDir]), ...targetGitWritableRoots(opts.gitRepoRoot)];
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

/**
 * Resolve the provider launch cwd (task 204). An explicit working_directory —
 * the assigned worktree for task workers — is used as-is and must be an
 * existing directory; launching elsewhere would silently run the worker
 * against the wrong checkout. With `require_git_checkout` (set for task
 * workers) it must also be a git checkout, so a half-removed worktree fails at
 * launch instead of at the worker's first commit, and it must be present.
 * Otherwise (scouts, tests) a missing working_directory falls back to the
 * orchestration root.
 */
export function resolveLaunchCwd(config: Record<string, unknown>): string {
  const workingDirectory = typeof config.working_directory === 'string' && config.working_directory
    ? config.working_directory
    : null;
  if (workingDirectory == null) {
    // A task worker must never fall back to the orchestration root: it would
    // run against the main checkout with a whole-root sandbox grant.
    if (config.require_git_checkout === true) throw new Error('worker launch requires an assigned worktree; none recorded');
    // A blank ORC_REPO_ROOT (project-mode workers) means "not set".
    return (config.env as Record<string, string> | undefined)?.ORC_REPO_ROOT || process.cwd();
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
  };
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
      args.push(...codexSandboxWritableRootArgs(sandboxRootsOptions(config, cwd)));
    } else {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    // Enable multi-agent support so Codex workers can spawn sub-agent reviewers.
    args.push('--enable', 'multi_agent');
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
    if (typeof config.model === 'string' && config.model) args.push('--model', config.model);
    return args;
  }
  if (typeof config.model === 'string' && config.model) {
    return ['--model', config.model];
  }
  return [];
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
  // Workers start in their assigned worktree (task 204); ORC_HOME/ORC_STATE_DIR
  // in the worker env keep `orc` state lookup pinned to the orchestration root.
  const cwd = resolveLaunchCwd(config);
  // For claude: write a settings file that installs a Notification hook so
  // permission_prompt events are pushed to the hook-events file in real time.
  // In sandbox mode, merge in a sandbox config block alongside the hook.
  let claudeSettingsFile: string | undefined;
  if (provider === 'claude') {
    claudeSettingsFile = settingsPath(agentId);
    const eventsFile = hookEventPath(agentId);
    // Inline node one-liner: reads stdin JSON, filters to permission_prompt
    // notifications, and appends a record to the hook-events NDJSON file.
    const hookCmd = `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const e=JSON.parse(d);if(e.notification_type!=='permission_prompt')return;require('fs').appendFileSync(${JSON.stringify(eventsFile)},JSON.stringify({type:'permission',message:e.message||'',ts:new Date().toISOString()})+'\\\\n')}catch(x){}})"`;
    const executionMode = typeof config.execution_mode === 'string' ? config.execution_mode : 'full-access';
    const settings: Record<string, unknown> = {
      hooks: {
        Notification: [{ hooks: [{ type: 'command', command: hookCmd }] }],
      },
    };
    if (executionMode === 'sandbox') {
      const sandboxConfig: Record<string, unknown> = {
        enabled: true,
        mode: 'auto-allow',
        allowUnsandboxedCommands: false,
      };
      const filesystem = claudeSandboxFilesystem(sandboxRootsOptions(config, cwd));
      if (filesystem) {
        sandboxConfig.filesystem = filesystem;
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

function writePidFile(agentId: string, pid: number): void {
  const identity = processIdentity(pid);
  writeFileSync(pidPath(agentId), JSON.stringify(identity ?? { pid, start: null }));
}

/** Accept both the JSON identity format and the legacy bare PID. */
function readPidFile(agentId: string): { pid: number; start: string | null } | null {
  const file = pidPath(agentId);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf8').trim();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'number') return Number.isSafeInteger(parsed) ? { pid: parsed, start: null } : null;
    const record = parsed as { pid?: unknown; start?: unknown };
    if (typeof record.pid !== 'number') return null;
    return { pid: record.pid, start: typeof record.start === 'string' ? record.start : null };
  } catch {
    return null;
  }
}

/** A legacy PID file has no start time, so only bare liveness can be checked. */
function pidFileProcessAlive(record: { pid: number; start: string | null }): boolean {
  return record.start ? isSameProcess({ pid: record.pid, start: record.start }) : isPidAlive(record.pid);
}

/** Create a "pty:{agentId}" session handle from an agent ID. */
export function createSessionHandle(agentId: string): string {
  return `pty:${agentId}`;
}

/** Parse "pty:{agentId}" → agentId. Throws on malformed handle. */
function parseHandle(sessionHandle: unknown) {
  const s = String(sessionHandle);
  if (!s.startsWith('pty:') || s.length <= 4) {
    throw new Error(`Invalid pty session handle: ${String(sessionHandle)}`);
  }
  return s.slice(4); // agentId
}

function readLogTail(agentId: string) {
  const path = logPath(agentId);
  if (!existsSync(path)) return '';
  const buf = readFileSync(path);
  return buf.slice(-OUTPUT_TAIL_BYTES).toString('utf8');
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

/**
 * Create a pty adapter for the given provider.
 *
 * @param options
 * @param options.provider - 'claude' | 'codex' | 'gemini'
 */
export function createPtyAdapter({ provider = 'claude' }: { provider?: string } = {}) {
  const binary = PROVIDER_BINARIES[provider] ?? provider;

  // In-process state. Only valid in the coordinator process that called start().
  const sessions      = new Map<string, ReturnType<typeof pty.spawn>>(); // agentId → IPty
  const outputStreams  = new Map<string, ReturnType<typeof createWriteStream>>(); // agentId → WriteStream
  const recentOutput = new Map<string, string>(); // agentId → recent sanitized PTY output

  function getRecentOutput(agentId: string) {
    return recentOutput.get(agentId) ?? readLogTail(agentId);
  }

  return {
    /**
     * Spawn the CLI binary as a PTY child process.
     * Streams output to the log file. Writes PID file.
     * Delivers bootstrap via ptyProcess.write().
     */
    async start(agentId: string, config: Record<string, unknown> = {}) {
      // Teardown any pre-existing session for this agentId.
      if (sessions.has(agentId)) {
        try { sessions.get(agentId)!.kill(); } catch { /* already dead */ }
        try { outputStreams.get(agentId)!.end(); } catch { /* ignore */ }
        sessions.delete(agentId);
        outputStreams.delete(agentId);
        recentOutput.delete(agentId);
      }

      ensureDirs();

      // Open output log — 'w' truncates so each session starts with a clean log.
      let stream: ReturnType<typeof createWriteStream> | undefined;
      let ptyProcess: ReturnType<typeof pty.spawn> | undefined;
      try {
        stream = createWriteStream(logPath(agentId), { flags: 'w' });
        stream.on('error', () => { /* output stream teardown races are non-fatal */ });

        const launch = prepareProviderLaunch(provider, agentId, config);
        ptyProcess = pty.spawn(launch.binary, launch.args, {
          name: 'xterm-256color',
          cols: 220,
          rows: 50,
          cwd: launch.cwd,
          env: launch.env,
        });

        ptyProcess.onData((data) => {
          const sanitized = sanitizePtyChunk(data);
          stream!.write(sanitized);
          const next = (recentOutput.get(agentId) ?? '') + sanitized;
          recentOutput.set(agentId, next.slice(-RECENT_OUTPUT_BYTES));
        });

        // Write PID file (with start time, to detect PID reuse) for cross-process heartbeat.
        writePidFile(agentId, ptyProcess.pid);

        sessions.set(agentId, ptyProcess);
        outputStreams.set(agentId, stream);
      } catch (error) {
        if (stream) {
          try { stream.destroy(); } catch { /* ignore */ }
        }
        throw error;
      }

      const spawned = ptyProcess;
      await runStartupDialogs((text) => spawned.write(text), provider, config, () => getRecentOutput(agentId));

      return {
        session_handle: `pty:${agentId}`,
        provider_ref: {
          pid: ptyProcess.pid, provider, binary, transport: 'pty',
          process_start: processIdentity(ptyProcess.pid)?.start ?? null,
        },
      };
    },

    /**
     * Write text to the agent's PTY (fire-and-forget).
     * Returns '' — the coordinator does not parse the return value.
     * Throws if the agent is not in the in-process sessions Map.
     */
    async send(sessionHandle: string, text: string) {
      const agentId    = parseHandle(sessionHandle);
      const ptyProcess = sessions.get(agentId);
      if (!ptyProcess) {
        throw new Error(
          `No active pty session for agent '${agentId}'. ` +
          `The coordinator must own the session — was start() called in this process?`,
        );
      }
      // All TUI provider CLIs (claude, codex, gemini) use PTY raw mode where
      // CR (0x0D) is the submit key, not LF. Large messages trigger a paste
      // indicator that must be dismissed with a separate CR write.
      // A short pause between the text and the CR is required for the TUI
      // to process the paste before accepting the submit keypress.
      ptyProcess.write(String(text));
      await new Promise((r) => setTimeout(r, 200));
      ptyProcess.write('\r');
      return '';
    },

    ownsSession(sessionHandle: string) {
      try {
        const agentId = parseHandle(sessionHandle);
        return sessions.has(agentId);
      } catch {
        return false;
      }
    },

    /**
     * Report liveness, writability and process identity. A PTY can only be
     * written by the process that spawned it, so a session that outlived its
     * coordinator is alive but not writable.
     */
    inspectSession(sessionHandle: string): SessionInspection {
      const agentId = parseHandle(sessionHandle);
      const owned = sessions.get(agentId);
      if (owned) {
        const identity = processIdentity(owned.pid);
        return { transport: 'pty', alive: identity != null, writable: identity != null, pid: owned.pid, processStart: identity?.start ?? null };
      }
      const record = readPidFile(agentId);
      if (!record) return { transport: 'pty', alive: false, writable: false, pid: null, processStart: null, reason: 'no pid file' };
      const alive = pidFileProcessAlive(record);
      return {
        transport: 'pty', alive, writable: false, pid: record.pid, processStart: record.start,
        reason: alive ? 'pty is owned by another process and cannot be written' : 'process exited or pid was reused',
      };
    },

    detectInputBlock(sessionHandle: string) {
      try {
        const agentId = parseHandle(sessionHandle);
        // Fast path: check push-based hook events (atomic consume via rename).
        // Hook events are high-confidence — written by the provider's own
        // notification system, not heuristic text matching.
        const events = consumeHookEvents(agentId);
        if (events.length > 0) {
          return events[0].message || 'permission prompt detected';
        }
        // Universal fallback: scan recent PTY output for blocking prompt patterns.
        const text = getRecentOutput(agentId);
        return detectBlockingPromptFromText(text);
      } catch {
        return null;
      }
    },

    getOutputTail(sessionHandle: string): string | null {
      try {
        const agentId = parseHandle(sessionHandle);
        const raw = readLogTail(agentId);
        return stripAnsi(raw).trim();
      } catch {
        return null;
      }
    },

    /**
     * Print the tail of the agent's output log to stdout.
     * Never throws.
     */
    attach(sessionHandle: string) {
      try {
        const agentId = parseHandle(sessionHandle);
        const path    = logPath(agentId);
        if (!existsSync(path)) {
          console.log('(no output log — agent session not yet started)');
          return;
        }
        const tail = readLogTail(agentId);
        console.log(tail);
      } catch {
        console.log('(could not read pty output log)');
      }
    },

    /**
     * Return true if the agent session is alive.
     *
     * Primary path: check in-process sessions Map (coordinator only).
     * Fallback path: read PID file and probe with process.kill(pid, 0)
     *                (works from any process — e.g. orc-attach CLI).
     *
     * Never throws — any error returns false.
     */
    heartbeatProbe(sessionHandle: string): Promise<boolean> {
      try {
        const agentId    = parseHandle(sessionHandle);
        const ptyProcess = sessions.get(agentId);

        if (ptyProcess) {
          try {
            process.kill(ptyProcess.pid, 0);
            return Promise.resolve(true);
          } catch {
            sessions.delete(agentId);
            return Promise.resolve(false);
          }
        }

        // Fallback: cross-process check via PID file, rejecting a reused PID.
        const record = readPidFile(agentId);
        return Promise.resolve(record != null && pidFileProcessAlive(record));
      } catch {
        return Promise.resolve(false);
      }
    },

    /**
     * Kill the PTY process and clean up all state.
     * No-op if the session is not found.
     */
    stop(sessionHandle: string): Promise<void> {
      try {
        const agentId = parseHandle(sessionHandle);

        const ptyProcess = sessions.get(agentId);
        if (ptyProcess) {
          try { ptyProcess.kill(); }    catch { /* already dead */ }
          try { outputStreams.get(agentId)!.end(); } catch { /* ignore */ }
          sessions.delete(agentId);
          outputStreams.delete(agentId);
          recentOutput.delete(agentId);
        }
        const pidFile = pidPath(agentId);
        try {
          // Never signal a PID that now belongs to an unrelated process.
          const record = readPidFile(agentId);
          if (record && pidFileProcessAlive(record)) {
            try { process.kill(record.pid, 'SIGTERM'); } catch { /* already dead or inaccessible */ }
          }
        } catch {
          // Ignore pid read/kill failures; unlink below is still best effort.
        }
        try { unlinkSync(pidFile); } catch { /* already gone */ }
        // Clean up hook events and settings files created for this session.
        try { unlinkSync(hookEventPath(agentId)); } catch { /* already gone or never created */ }
        try { unlinkSync(`${hookEventPath(agentId)}.processing`); } catch { /* already gone */ }
        try { unlinkSync(settingsPath(agentId)); } catch { /* already gone or never created */ }
      } catch {
        // No-op — malformed handle or session already cleaned up.
      }
      return Promise.resolve();
    },
  };
}
