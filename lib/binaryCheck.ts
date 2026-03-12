/**
 * lib/binaryCheck.ts
 *
 * Utility for checking whether a provider CLI binary is available on $PATH
 * and optionally installing it via npm when it is missing.
 */
import { execFileSync } from 'node:child_process';
import { isInteractive } from './prompts.ts';

let promptModulePromise: Promise<typeof import('@inquirer/prompts')> | null = null;

async function getPromptModule(): Promise<typeof import('@inquirer/prompts')> {
  if (!promptModulePromise) {
    promptModulePromise = import('@inquirer/prompts');
  }
  return promptModulePromise;
}

export const PROVIDER_BINARIES: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
};

export const PROVIDER_PROMPT_PATTERNS: Record<string, RegExp> = {
  claude: />\s*$/,
  codex: /(>\s*$|›\s*$|❯\s*$)/,
  gemini: /(>\s*$|›\s*$|❯\s*$)/,
};

export const PROVIDER_SUBMIT_SEQUENCES: Record<string, string> = {
  claude: '\r',
  codex: '\r',
  gemini: '\r',
};

export const PROVIDER_PACKAGES: Record<string, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli',
};

/**
 * Returns true if binary is found on $PATH. Never throws.
 */
export function isBinaryAvailable(binary: string): boolean {
  try {
    execFileSync('which', [binary], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure provider CLI binary exists; optionally install with npm in interactive mode.
 */
export async function checkAndInstallBinary(provider: string): Promise<boolean> {
  const binary = PROVIDER_BINARIES[provider] ?? provider;
  const packageName = PROVIDER_PACKAGES[provider];

  if (isBinaryAvailable(binary)) return true;

  console.error(`\nBinary '${binary}' is not installed or not on $PATH.`);

  if (!isInteractive()) {
    if (packageName) {
      console.error(`To install it, run:  npm install -g ${packageName}`);
    }
    console.error('(or use Homebrew / your preferred package manager)');
    return false;
  }

  if (!packageName) {
    console.error(`No install package mapping found for provider '${provider}'.`);
    return false;
  }

  console.log('\nInstalling via npm will run:');
  console.log(`  npm install -g ${packageName}`);
  console.log('(Cancel now with Ctrl-C if you prefer Homebrew or another package manager.)\n');

  const { confirm } = await getPromptModule();
  const proceed = await confirm({
    message: `Install ${packageName} now?`,
    default: true,
  }).catch(() => false);

  if (!proceed) {
    console.log('Skipped. Install manually and re-run.');
    return false;
  }

  try {
    console.log(`\nRunning: npm install -g ${packageName}\n`);
    execFileSync('npm', ['install', '-g', packageName], { stdio: 'inherit' });
  } catch {
    console.error(`\nInstall failed. Try manually: npm install -g ${packageName}`);
    return false;
  }

  if (isBinaryAvailable(binary)) {
    console.log(`\n✓ '${binary}' is now available.`);
    return true;
  }

  console.error(`\nInstall appeared to succeed but '${binary}' is still not found on $PATH.`);
  console.error('You may need to start a new shell session for the PATH update to take effect.');
  return false;
}
