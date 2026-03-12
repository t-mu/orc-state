/**
 * adapters/pty.mjs
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
import { join } from 'node:path';
import { STATE_DIR } from '../lib/paths.mjs';

const PROVIDER_BINARIES = {
  claude: 'claude',
  codex:  'codex',
  gemini: 'gemini',
};

const OUTPUT_TAIL_BYTES = 8 * 1024; // 8 KB
const STARTUP_DELAY_MS  = 1500;     // wait for CLI to initialise before sending bootstrap
const BLOCKING_PROMPT_PATTERNS = [
  /would you like[^\n]*\[(?:y\/n|yes\/no)\]/i,
  /\b(?:apply|approve|continue|proceed|confirm)[^\n]*\[(?:y\/n|yes\/no)\]/i,
  /[^\n?]+\?\s*\[(?:y\/n|yes\/no)\]/i,
];

function pidPath(agentId) { return join(STATE_DIR, 'pty-pids', `${agentId}.pid`); }
function logPath(agentId) { return join(STATE_DIR, 'pty-logs', `${agentId}.log`); }

function ensureDirs() {
  mkdirSync(join(STATE_DIR, 'pty-pids'), { recursive: true });
  mkdirSync(join(STATE_DIR, 'pty-logs'), { recursive: true });
}

function buildStartArgs(provider, config) {
  // Codex supports an initial prompt argument; pass bootstrap at spawn time
  // instead of PTY post-start injection, which the TUI treats as pasted text.
  if (provider === 'codex') {
    const args = [
      '--no-alt-screen',
      '--sandbox', 'workspace-write',
      '--ask-for-approval', 'never',
    ];
    if (config.system_prompt) args.push(String(config.system_prompt));
    return args;
  }
  return [];
}

/** Parse "pty:{agentId}" → agentId. Throws on malformed handle. */
function parseHandle(sessionHandle) {
  const s = String(sessionHandle);
  if (!s.startsWith('pty:') || s.length <= 4) {
    throw new Error(`Invalid pty session handle: ${sessionHandle}`);
  }
  return s.slice(4); // agentId
}

function readLogTail(agentId) {
  const path = logPath(agentId);
  if (!existsSync(path)) return '';
  const buf = readFileSync(path);
  return buf.slice(-OUTPUT_TAIL_BYTES).toString('utf8');
}

function detectBlockingPromptFromText(text) {
  const lines = String(text)
    .split('\n')
    .map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (BLOCKING_PROMPT_PATTERNS.some((pattern) => pattern.test(line))) {
      return line;
    }
  }
  return null;
}

/**
 * Create a pty adapter for the given provider.
 *
 * @param {object} [options]
 * @param {'claude'|'codex'|'gemini'} [options.provider='claude']
 */
export function createPtyAdapter({ provider = 'claude' } = {}) {
  const binary = PROVIDER_BINARIES[provider] ?? provider;

  // In-process state. Only valid in the coordinator process that called start().
  const sessions      = new Map(); // agentId → IPty
  const outputStreams  = new Map(); // agentId → WriteStream

  return {
    /**
     * Spawn the CLI binary as a PTY child process.
     * Streams output to the log file. Writes PID file.
     * Delivers bootstrap via ptyProcess.write().
     */
    async start(agentId, config = {}) {
      // Teardown any pre-existing session for this agentId.
      if (sessions.has(agentId)) {
        try { sessions.get(agentId).kill(); } catch { /* already dead */ }
        try { outputStreams.get(agentId).end(); } catch { /* ignore */ }
        sessions.delete(agentId);
        outputStreams.delete(agentId);
      }

      ensureDirs();

      // Open output log — 'w' truncates so each session starts with a clean log.
      let stream;
      let ptyProcess;
      try {
        stream = createWriteStream(logPath(agentId), { flags: 'w' });
        stream.on('error', () => { /* output stream teardown races are non-fatal */ });
        const spawnArgs = buildStartArgs(provider, config);

        // Strip CLAUDECODE so nested claude sessions are not rejected.
        const { CLAUDECODE: _cc, ...spawnEnv } = process.env;
        ptyProcess = pty.spawn(binary, spawnArgs, {
          name: 'xterm-256color',
          cols: 220,
          rows: 50,
          cwd:  config.working_directory ?? process.cwd(),
          env:  { ...spawnEnv, ...(config.env ?? {}) },
        });

        ptyProcess.onData((data) => stream.write(data));

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
      if (provider !== 'codex' && config.system_prompt) {
        await new Promise((r) => setTimeout(r, STARTUP_DELAY_MS));
        ptyProcess.write(String(config.system_prompt));
        await new Promise((r) => setTimeout(r, 500));
        ptyProcess.write('\r');
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
    async send(sessionHandle, text) {
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

    ownsSession(sessionHandle) {
      try {
        const agentId = parseHandle(sessionHandle);
        return sessions.has(agentId);
      } catch {
        return false;
      }
    },

    detectInputBlock(sessionHandle) {
      try {
        const agentId = parseHandle(sessionHandle);
        const text = readLogTail(agentId);
        return detectBlockingPromptFromText(text);
      } catch {
        return null;
      }
    },

    /**
     * Print the tail of the agent's output log to stdout.
     * Never throws.
     */
    attach(sessionHandle) {
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
    async heartbeatProbe(sessionHandle) {
      try {
        const agentId    = parseHandle(sessionHandle);
        const ptyProcess = sessions.get(agentId);

        if (ptyProcess) {
          try {
            process.kill(ptyProcess.pid, 0);
            return true;
          } catch {
            sessions.delete(agentId);
            return false;
          }
        }

        // Fallback: cross-process check via PID file.
        const pidFile = pidPath(agentId);
        if (!existsSync(pidFile)) return false;
        const pid = parseInt(readFileSync(pidFile, 'utf8'), 10);
        if (!Number.isFinite(pid)) return false;
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Kill the PTY process and clean up all state.
     * No-op if the session is not found.
     */
    async stop(sessionHandle) {
      try {
        const agentId = parseHandle(sessionHandle);

        const ptyProcess = sessions.get(agentId);
        if (ptyProcess) {
          try { ptyProcess.kill(); }    catch { /* already dead */ }
          try { outputStreams.get(agentId).end(); } catch { /* ignore */ }
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
      } catch {
        // No-op — malformed handle or session already cleaned up.
      }
    },
  };
}
