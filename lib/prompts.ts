/**
 * lib/prompts.ts
 * Shared interactive prompt utilities for orchestrator CLI scripts.
 * Uses @inquirer/prompts for arrow-key-navigable TTY prompts.
 * All functions short-circuit when the value is already provided (flag bypass).
 */
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
  if (e.name === 'ExitPromptError') { console.log('Cancelled.'); process.exit(0); }
  throw e;
}

/**
 * Each prompt function:
 *   - returns `existing` immediately if it is truthy (flag already provided → no prompt)
 *   - shows an interactive prompt if running in a TTY
 *   - returns null if not interactive (caller must validate and exit with usage message)
 */

export async function promptAgentId(existing: string | null): Promise<string | null> {
  if (existing) return existing;
  if (!isInteractive()) return null;
  const { input } = await getPromptModule();
  return input({
    message: 'Agent ID (e.g. worker-01)',
    validate: (v) => /^[a-z0-9][a-z0-9-]*$/.test(v) || 'Must match [a-z0-9][a-z0-9-]*',
  }).catch(onCancel);
}

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

export async function promptRole(existing: string | null): Promise<string | null> {
  if (existing) return existing;
  if (!isInteractive()) return null;
  const { select } = await getPromptModule();
  return select({
    message: 'Select role',
    choices: [
      { value: 'worker',   name: 'Worker',   description: 'executes tasks'      },
      { value: 'reviewer', name: 'Reviewer', description: 'reviews output'      },
      { value: 'scout',    name: 'Scout',    description: 'investigates read-only' },
      { value: 'master',   name: 'Master',   description: 'delegates and plans' },
    ],
  }).catch(onCancel);
}

export async function promptWorkerRole(existing: string | null): Promise<string | null> {
  if (existing) return existing;
  if (!isInteractive()) return null;
  const { select } = await getPromptModule();
  return select({
    message: 'Select non-master role',
    choices: [
      { value: 'worker',   name: 'Worker',   description: 'executes delegated tasks' },
      { value: 'reviewer', name: 'Reviewer', description: 'reviews worker output' },
      { value: 'scout',    name: 'Scout',    description: 'investigates code, logs, and runs' },
    ],
  }).catch(onCancel);
}

/**
 * @param existing - null means not provided (prompt); '' means explicitly empty
 */
export async function promptCapabilities(existing: string | null): Promise<string> {
  if (existing != null) return existing; // empty string is a valid "no capabilities"
  if (!isInteractive()) return '';
  const { input } = await getPromptModule();
  return input({
    message: 'Capabilities (comma-separated, optional — leave blank for none)',
    default: '',
  }).catch(onCancel);
}

export async function promptCoordinatorAction(coordinatorPid: number | null): Promise<string> {
  if (coordinatorPid) {
    console.log(`\nCoordinator is already running (PID ${coordinatorPid}).`);
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

  console.log('\nCoordinator is not running.');
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
    console.log('\n=== MASTER SESSION ===');
    console.log('This terminal is reserved for the master session.');
    console.log('The master plans and delegates. It is not a worker.');
    console.log('Master is not registered.');
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

  console.log(
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
