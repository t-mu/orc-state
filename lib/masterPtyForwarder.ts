import { readAndMarkConsumed } from './masterNotifyQueue.ts';
import { PROVIDER_PROMPT_PATTERNS, PROVIDER_SUBMIT_SEQUENCES } from './binaryCheck.ts';
import type { QueueEntry } from './masterNotifyQueue.ts';
import { PTY_POLL_INTERVAL_MS } from './constants.ts';

const POLL_INTERVAL_MS = PTY_POLL_INTERVAL_MS;
const PROMPT_STALE_MS = 60_000;
const DEFAULT_PROMPT_PATTERN = />\s*$/;
const DEFAULT_SUBMIT_SEQUENCE = '\r';

interface PtyLike {
  write(data: string): void;
}

interface DataEmitter {
  onData(callback: (chunk: string) => void): { dispose(): void } | undefined;
}

export interface ForwarderOptions {
  promptPattern?: RegExp;
  provider?: string;
  submitSequence?: string;
}

function formatResult(success: boolean): string {
  return success ? '✓ success' : '✗ failed';
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function formatInputRequest(notification: QueueEntry): string {
  return [
    `[ORCHESTRATOR] INPUT_REQUEST`,
    `task=${str(notification['task_ref'], '(unknown)')}`,
    `worker=${str(notification['agent_id'], '(unknown)')}`,
    `run=${str(notification['run_id'], '(unknown)')}`,
    `question=${str(notification['question'], '(question missing)')}`,
    'Ask the user for the missing answer, then respond with respond_input(run_id, agent_id, response).',
  ].join(' ');
}

function formatNotifications(notifications: QueueEntry[]): string {
  // Single-line format: no embedded \n so Claude Code stays in single-line input
  // mode and \r submits immediately instead of inserting a newline.
  const parts = notifications.map((notification) => {
    if (notification['type'] === 'INPUT_REQUEST') {
      return formatInputRequest(notification);
    }
    return `[ORCHESTRATOR] TASK_COMPLETE task=${str(notification['task_ref'], '(unknown)')} worker=${str(notification['agent_id'], '(unknown)')} result=${formatResult(notification['success'] === true)} time=${str(notification['finished_at'], new Date().toISOString())}`;
  });
  return parts.join(' | ');
}

export function stripAnsi(value: unknown): string {
  return String(value).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function isIdlePromptVisible(chunk: string, promptPattern: RegExp): boolean {
  const plain = stripAnsi(chunk);
  return promptPattern.test(plain);
}

function resolvePromptPattern(options: ForwarderOptions | undefined): RegExp {
  if (options?.promptPattern instanceof RegExp) return options.promptPattern;
  if (options?.provider && PROVIDER_PROMPT_PATTERNS[options.provider]) {
    return PROVIDER_PROMPT_PATTERNS[options.provider];
  }
  return DEFAULT_PROMPT_PATTERN;
}

function resolveSubmitSequence(options: ForwarderOptions | undefined): string {
  if (typeof options?.submitSequence === 'string') return options.submitSequence;
  if (options?.provider && PROVIDER_SUBMIT_SEQUENCES[options.provider]) {
    return PROVIDER_SUBMIT_SEQUENCES[options.provider];
  }
  return DEFAULT_SUBMIT_SEQUENCE;
}

export function startMasterPtyForwarder(
  stateDir: string,
  masterPty: PtyLike | null | undefined,
  ptyDataEmitter: DataEmitter | null | undefined,
  options: ForwarderOptions = {},
): () => void {
  let lastStdinActivity = 0;
  let lastPromptAt = 0;
  let bracketedPasteEnabled = false;
  const promptPattern = resolvePromptPattern(options);
  const submitSequence = resolveSubmitSequence(options);

  const stdinHandler = (): void => {
    lastStdinActivity = Date.now();
  };
  process.stdin.on('data', stdinHandler);
  const dataDisposable = ptyDataEmitter?.onData((chunk: string) => {
    if (chunk.includes('\x1b[?2004h')) bracketedPasteEnabled = true;
    if (chunk.includes('\x1b[?2004l')) bracketedPasteEnabled = false;
    if (isIdlePromptVisible(chunk, promptPattern)) lastPromptAt = Date.now();
  });

  const timer = setInterval(() => {
    if (!masterPty) return;
    if (lastPromptAt === 0) return;
    if (lastPromptAt <= lastStdinActivity) return;
    if (Date.now() - lastPromptAt > PROMPT_STALE_MS) return;

    const pending = readAndMarkConsumed(stateDir);
    if (pending.length === 0) return;

    try {
      const text = formatNotifications(pending).trimEnd();
      const payload = bracketedPasteEnabled
        ? '\x1b[200~' + text + '\x1b[201~'
        : text;
      masterPty.write(payload);
      // Delay the submit keystroke so the readline has time to exit bracketed
      // paste mode and return to normal input state before seeing Enter.
      const ptyRef = masterPty;
      setTimeout(() => {
        try { ptyRef.write(submitSequence); } catch { /* PTY gone */ }
      }, 200);
      lastPromptAt = 0;
    } catch {
      // PTY may already be gone; caller controls lifecycle via stop function.
    }
  }, POLL_INTERVAL_MS);

  return (): void => {
    clearInterval(timer);
    process.stdin.off('data', stdinHandler);
    dataDisposable?.dispose();
  };
}
