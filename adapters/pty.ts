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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { STATE_DIR, hookEventPath } from '../lib/paths.ts';
import { stripAnsi } from '../lib/ansi.ts';

const PROVIDER_BINARIES: Record<string, string> = {
  claude: 'claude',
  codex:  'codex',
  gemini: 'gemini',
};

const OUTPUT_TAIL_BYTES  = 8 * 1024; // 8 KB
const STARTUP_DELAY_MS   = 1500;     // wait for CLI to initialise before sending bootstrap
const BYPASS_SETTLE_MS   = 800;      // wait after bypass-accept for dialog to dismiss
const BLOCKING_PROMPT_PATTERNS = [
  /would you like[^\n]*\[(?:y\/n|yes\/no)\]/i,
  /\b(?:apply|approve|continue|proceed|confirm)[^\n]*\[(?:y\/n|yes\/no)\]/i,
  /[^\n?]+\?\s*\[(?:y\/n|yes\/no)\]/i,
  // Claude Code permission dialogs
  /allow\s+(?:this\s+)?(?:tool|command|action|operation)[^\n]*\?/i,
  /do you (?:want|wish) to (?:allow|grant|permit|run|execute)[^\n]*/i,
  /permission (?:required|needed|requested)[^\n]*/i,
];

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

function buildStartArgs(provider: string, config: Record<string, unknown>, claudeSettingsPath?: string) {
  // Codex supports an initial prompt argument; pass bootstrap at spawn time
  // instead of PTY post-start injection, which the TUI treats as pasted text.
  if (provider === 'codex') {
    const args = [
      '--dangerously-bypass-approvals-and-sandbox',
    ];
    if (typeof config.system_prompt === 'string' && config.system_prompt) args.push(config.system_prompt);
    return args;
  }
  if (provider === 'claude') {
    // Skip interactive permission prompts so workers can run bash commands
    // without blocking on "Do you want to proceed?" confirmations.
    const args = ['--dangerously-skip-permissions'];
    if (claudeSettingsPath) args.push('--settings', claudeSettingsPath);
    return args;
  }
  return [];
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

function resolveBinary(binary: string, env: Record<string, string>) {
  if (!binary || binary.includes('/') || isAbsolute(binary)) return binary;
  const searchPath = env.PATH ?? process.env.PATH ?? '';
  for (const dir of searchPath.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return binary;
}

function detectBlockingPromptFromText(text: string) {
  const lines = String(text)
    .split('\n')
    .map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
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
      }

      ensureDirs();

      // Open output log — 'w' truncates so each session starts with a clean log.
      let stream: ReturnType<typeof createWriteStream> | undefined;
      let ptyProcess: ReturnType<typeof pty.spawn> | undefined;
      try {
        stream = createWriteStream(logPath(agentId), { flags: 'w' });
        stream.on('error', () => { /* output stream teardown races are non-fatal */ });

        // For claude: write a settings file that installs a Notification hook so
        // permission_prompt events are pushed to the hook-events file in real time.
        let claudeSettingsFile: string | undefined;
        if (provider === 'claude') {
          claudeSettingsFile = settingsPath(agentId);
          const eventsFile = hookEventPath(agentId);
          // Inline node one-liner: reads stdin JSON, filters to permission_prompt
          // notifications, and appends a record to the hook-events NDJSON file.
          const hookCmd = `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const e=JSON.parse(d);if(e.notification_type!=='permission_prompt')return;require('fs').appendFileSync(${JSON.stringify(eventsFile)},JSON.stringify({type:'permission',message:e.message||'',ts:new Date().toISOString()})+'\\\\n')}catch(x){}})"`;
          writeFileSync(claudeSettingsFile, JSON.stringify({
            hooks: {
              Notification: [{ hooks: [{ type: 'command', command: hookCmd }] }],
            },
          }));
        }

        const spawnArgs = buildStartArgs(provider, config, claudeSettingsFile);

        // Strip CLAUDECODE so nested claude sessions are not rejected.
        const { CLAUDECODE: _cc, ...baseEnv } = process.env;
        const spawnEnv = { ...baseEnv, ...(config.env as Record<string, string> ?? {}) } as Record<string, string>;
        const resolvedBinary = resolveBinary(binary, spawnEnv);
        ptyProcess = pty.spawn(resolvedBinary, spawnArgs, {
          name: 'xterm-256color',
          cols: 220,
          rows: 50,
          // Spawn at the repo root so the sandbox covers both the worktree and
          // .orc-state/. Workers navigate to their assigned worktree themselves
          // via the cd instruction in the TASK_START envelope.
          cwd:  (config.env as Record<string, string> | undefined)?.ORC_REPO_ROOT
            ?? (config.working_directory as string)
            ?? process.cwd(),
          env: spawnEnv,
        });

        ptyProcess.onData((data) => stream!.write(sanitizePtyChunk(data)));

        // Write PID file for cross-process heartbeat.
        writeFileSync(pidPath(agentId), String(ptyProcess.pid));

        sessions.set(agentId, ptyProcess);
        outputStreams.set(agentId, stream);
      } catch (error) {
        if (stream) {
          try { stream.destroy(); } catch { /* ignore */ }
        }
        throw error;
      }

      // Providers that do not support startup prompt args still receive
      // bootstrap via PTY write after their REPL has initialized.
      // Two-phase write: first the text (TUI shows paste indicator),
      // then a separate CR after a short pause to submit the paste.
      if (provider !== 'codex') {
        await new Promise((r) => setTimeout(r, STARTUP_DELAY_MS));

        // Claude --dangerously-skip-permissions shows a "Bypass Permissions mode"
        // confirmation menu ("1. No, exit / 2. Yes, I accept") before the REPL
        // is ready. Auto-accept it so headless sessions don't stall.
        if (provider === 'claude') {
          ptyProcess.write('2');
          await new Promise((r) => setTimeout(r, 200));
          ptyProcess.write('\r');
          // Give the TUI time to dismiss the dialog and render the REPL.
          await new Promise((r) => setTimeout(r, BYPASS_SETTLE_MS));
        }

        if (config.system_prompt && typeof config.system_prompt === 'string') {
          ptyProcess.write(config.system_prompt);
          await new Promise((r) => setTimeout(r, 500));
          ptyProcess.write('\r');
        }
      }

      return {
        session_handle: `pty:${agentId}`,
        provider_ref: { pid: ptyProcess.pid, provider, binary },
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

    detectInputBlock(sessionHandle: string) {
      try {
        const agentId = parseHandle(sessionHandle);
        // Fast path (claude only): check push-based hook events file first.
        const eventsFile = hookEventPath(agentId);
        if (existsSync(eventsFile)) {
          try {
            const lines = readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean);
            if (lines.length > 0) {
              const event = JSON.parse(lines[0]) as { message?: string };
              return (typeof event.message === 'string' && event.message) ? event.message : 'permission prompt detected';
            }
          } catch { /* fall through to PTY scan */ }
        }
        // Universal fallback: scan recent PTY output for blocking prompt patterns.
        const text = readLogTail(agentId);
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

        // Fallback: cross-process check via PID file.
        const pidFile = pidPath(agentId);
        if (!existsSync(pidFile)) return Promise.resolve(false);
        const pid = parseInt(readFileSync(pidFile, 'utf8'), 10);
        if (!Number.isFinite(pid)) return Promise.resolve(false);
        process.kill(pid, 0);
        return Promise.resolve(true);
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
        }
        const pidFile = pidPath(agentId);
        if (existsSync(pidFile)) {
          try {
            const pid = parseInt(readFileSync(pidFile, 'utf8'), 10);
            if (Number.isFinite(pid)) {
              try { process.kill(pid, 'SIGTERM'); } catch { /* already dead or inaccessible */ }
            }
          } catch {
            // Ignore pid read/kill failures; unlink below is still best effort.
          }
        }
        try { unlinkSync(pidFile); } catch { /* already gone */ }
        // Clean up hook events and settings files created for this session.
        try { unlinkSync(hookEventPath(agentId)); } catch { /* already gone or never created */ }
        try { unlinkSync(settingsPath(agentId)); } catch { /* already gone or never created */ }
      } catch {
        // No-op — malformed handle or session already cleaned up.
      }
      return Promise.resolve();
    },
  };
}
