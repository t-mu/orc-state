import { readFileSync } from 'node:fs';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  select: vi.fn(),
}));

import { select } from '@inquirer/prompts';
import {
  isInteractive,
  promptProvider,
  printManagedWorkerNotice,
} from './prompts.ts';

// ── TTY helpers ────────────────────────────────────────────────────────────

function setTTY(stdin: boolean | undefined, stdout = stdin) {
  Object.defineProperty(process.stdin,  'isTTY', { value: stdin,  writable: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: stdout, writable: true, configurable: true });
}

// Restore to undefined (the non-TTY default in test environments)
function resetTTY() { setTTY(undefined); }

// ExitPromptError is what @inquirer/prompts throws when the user presses Ctrl-C
function makeExitError() {
  return Object.assign(new Error('User force closed the prompt'), { name: 'ExitPromptError' });
}

// When process.exit is mocked as a no-op, onCancel falls through to `throw e`.
// Instead, make process.exit throw a recognisable sentinel so the cancel path
// terminates and we can assert that exit(0) was reached.
function spyExit() {
  return vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('__process_exit__');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTTY();
});

afterEach(() => {
  resetTTY();
});

// ── isInteractive() ────────────────────────────────────────────────────────

describe('isInteractive()', () => {
  it('returns true when both stdin and stdout are TTYs', () => {
    setTTY(true);
    expect(isInteractive()).toBe(true);
  });

  it('returns false when stdin is not a TTY', () => {
    setTTY(false, true);
    expect(isInteractive()).toBe(false);
  });

  it('returns false when stdout is not a TTY', () => {
    setTTY(true, false);
    expect(isInteractive()).toBe(false);
  });
});

// ── promptProvider() ───────────────────────────────────────────────────────

describe('promptProvider()', () => {
  describe('flag bypass', () => {
    it('returns existing value without calling select()', async () => {
      const result = await promptProvider('codex');
      expect(result).toBe('codex');
      expect(select).not.toHaveBeenCalled();
    });
  });

  describe('non-interactive', () => {
    it('returns null without calling select()', async () => {
      const result = await promptProvider(null);
      expect(result).toBeNull();
      expect(select).not.toHaveBeenCalled();
    });
  });

  describe('interactive', () => {
    beforeEach(() => setTTY(true));

    it('calls select() and returns its resolved value', async () => {
      vi.mocked(select).mockResolvedValue('gemini');
      const result = await promptProvider(null);
      expect(select).toHaveBeenCalledOnce();
      expect(result).toBe('gemini');
    });

    it('passes a custom provider message to select() when provided', async () => {
      vi.mocked(select).mockResolvedValue('claude');
      await promptProvider(null, { message: 'Select provider for MASTER session' });
      expect(select).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Select provider for MASTER session',
      }));
    });

    it('passes all three provider choices to select()', async () => {
      vi.mocked(select).mockResolvedValue('claude');
      await promptProvider(null);
      expect(select).toHaveBeenCalledWith(expect.objectContaining({
        choices: expect.arrayContaining([
          expect.objectContaining({ value: 'claude' }),
          expect.objectContaining({ value: 'codex' }),
          expect.objectContaining({ value: 'gemini' }),
        ]),
      }));
    });

    it('calls process.exit(0) on ExitPromptError', async () => {
      vi.mocked(select).mockRejectedValue(makeExitError());
      const exitSpy = spyExit();
      await expect(promptProvider(null)).rejects.toThrow('__process_exit__');
      expect(exitSpy).toHaveBeenCalledWith(0);
      exitSpy.mockRestore();
    });

    it('re-throws non-ExitPromptError errors', async () => {
      vi.mocked(select).mockRejectedValue(new Error('timeout'));
      await expect(promptProvider(null)).rejects.toThrow('timeout');
    });
  });
});

describe('printManagedWorkerNotice()', () => {
  it('prints coordinator-managed worker guidance for normal startup', () => {
    const lines: string[] = [];
    printManagedWorkerNotice((line) => lines.push(line));

    expect(lines.join('\n')).toContain('MANAGED WORKERS');
    expect(lines.join('\n')).toContain('launched per task by the coordinator');
    expect(lines.join('\n')).toContain('does not register or start workers manually');
    expect(lines.join('\n')).toContain('debugging, inspection, or recovery');
  });
});

describe('active runtime contract docs', () => {
  const activePaths = [
    '../contracts.md',
    '../README.md',
    '../adapters/interface.ts',
    '../templates/master-bootstrap-v1.txt',
  ];

  it('describe orc run-* as the active worker reporting contract', () => {
    const contracts = readFileSync(new URL('../contracts.md', import.meta.url), 'utf8');
    expect(contracts).toContain('orc run-start');
    expect(contracts).toContain('orc run-heartbeat');
    expect(contracts).toContain('orc run-finish');
    expect(contracts).toContain('orc run-fail');
  });

  it('do not advertise [ORC_EVENT] as the active worker protocol in active docs/comments', () => {
    const offenders = activePaths.filter((path) =>
      readFileSync(new URL(path, import.meta.url), 'utf8').includes('[ORC_EVENT]'),
    );

    expect(offenders).toEqual([]);
  });

  it('do not describe API-backed workers as the active runtime model in active docs/comments', () => {
    const stalePhrases = [
      'API-backed workers',
      'API backed workers',
      'provider credential env var exists',
      'response parsing',
      'response-parsing',
    ];

    const offenders = activePaths.filter((path) => {
      const content = readFileSync(new URL(path, import.meta.url), 'utf8');
      return stalePhrases.some((phrase) => content.includes(phrase));
    });

    expect(offenders).toEqual([]);
  });
});

