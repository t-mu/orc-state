/**
 * lib/prompts.ts
 * Shared interactive prompt utilities for orchestrator CLI scripts.
 * Uses @inquirer/prompts for arrow-key-navigable TTY prompts.
 * All functions short-circuit when the value is already provided (flag bypass).
 */
import { logger } from './logger.ts';

let promptModulePromise: Promise<typeof import('@inquirer/prompts')> | null = null;

async function getPromptModule(): Promise<typeof import('@inquirer/prompts')> {
  if (!promptModulePromise) {
    promptModulePromise = import('@inquirer/prompts');
  }
  return promptModulePromise;
}

/** True when both stdin and stdout are a real TTY (not piped / CI). */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Ctrl-C in any inquirer prompt throws ExitPromptError — exit cleanly. */
function onCancel(e: Error): never {
  if (e.name === 'ExitPromptError') { logger.warn('Cancelled.'); process.exit(0); }
  throw e;
}

/**
 * Each prompt function:
 *   - returns `existing` immediately if it is truthy (flag already provided → no prompt)
 *   - shows an interactive prompt if running in a TTY
 *   - returns null if not interactive (caller must validate and exit with usage message)
 */

export async function promptProvider(
  existing: string | null,
  options: { message?: string } = {},
): Promise<string | null> {
  if (existing) return existing;
  if (!isInteractive()) return null;
  const message = typeof options.message === 'string' && options.message.trim()
    ? options.message.trim()
    : 'Select provider';
  const { select } = await getPromptModule();
  return select({
    message,
    choices: [
      { value: 'claude', name: 'Claude',         description: 'CLI installed + authenticated' },
      { value: 'codex',  name: 'Codex (OpenAI)', description: 'CLI installed + authenticated' },
      { value: 'gemini', name: 'Gemini (Google)', description: 'CLI installed + authenticated'  },
    ],
  }).catch(onCancel);
}

export async function promptCoordinatorAction(coordinatorPid: number | null): Promise<string> {
  if (coordinatorPid) {
    logger.warn(`\nCoordinator is already running (PID ${coordinatorPid}).`);
    if (!isInteractive()) return 'reuse';
    const { select } = await getPromptModule();
    return select({
      message: 'Coordinator action',
      choices: [
        {
          value: 'reuse',
          name: 'Reuse running coordinator',
          description: 'Keep current coordinator process',
        },
        {
          value: 'terminate',
          name: 'Terminate and restart coordinator',
          description: 'Stop current process and start a fresh one',
        },
        {
          value: 'cancel',
          name: 'Cancel',
          description: 'Exit without changes',
        },
      ],
    }).catch(onCancel);
  }

  logger.warn('\nCoordinator is not running.');
  if (!isInteractive()) return 'start';
  const { select } = await getPromptModule();
  return select({
    message: 'Coordinator action',
    choices: [
      {
        value: 'start',
        name: 'Start coordinator',
        description: 'Launch a new coordinator process',
      },
      {
        value: 'cancel',
        name: 'Cancel',
        description: 'Exit without changes',
      },
    ],
  }).catch(onCancel);
}

export async function promptMasterAction(existingMaster: { agent_id: string; provider: string; status?: string } | null): Promise<string> {
  if (!existingMaster) {
    logger.warn('\n=== MASTER SESSION ===');
    logger.warn('This terminal is reserved for the master session.');
    logger.warn('The master plans and delegates. It is not a worker.');
    logger.warn('Master is not registered.');
    if (!isInteractive()) return 'register';
    const { select } = await getPromptModule();
    return select({
      message: 'Master action',
      choices: [
        {
          value: 'register',
          name: 'Create master',
          description: "Register 'master' and start a provider session",
        },
        {
          value: 'cancel',
          name: 'Cancel',
          description: 'Exit without changes',
        },
      ],
    }).catch(onCancel);
  }

  logger.warn(
    `\n=== MASTER SESSION ===\nThis terminal is reserved for the master session.\nThe master plans and delegates. It is not a worker.\nMaster registration found: '${existingMaster.agent_id}' (${existingMaster.provider}) status=${existingMaster.status}.`,
  );
  if (!isInteractive()) return 'reuse';
  const { select } = await getPromptModule();
  return select({
    message: 'Master action',
    choices: [
      {
        value: 'reuse',
        name: 'Reuse existing master',
        description: 'Keep current master agent record',
      },
      {
        value: 'replace',
        name: `Replace master '${existingMaster.agent_id}'`,
        description: "Remove current master and create a new 'master'",
      },
      {
        value: 'cancel',
        name: 'Cancel',
        description: 'Exit without changes',
      },
    ],
  }).catch(onCancel);
}

export function printManagedWorkerNotice(log: (msg: string) => void = console.log): void {
  log('\n=== MANAGED WORKERS ===');
  log('Headless workers are launched per task by the coordinator.');
  log('Normal startup does not register or start workers manually.');
  log('Use worker CLIs only for debugging, inspection, or recovery.');
}
