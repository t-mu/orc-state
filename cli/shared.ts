import { existsSync } from 'node:fs';
import { assertProjectScope, STATE_DIR } from '../lib/paths.ts';
import { readClaims } from '../lib/stateReader.ts';
import type { Claim } from '../types/claims.ts';

export function loadClaim(runId: string): Claim | null {
  try {
    return readClaims(STATE_DIR).claims.find((claim) => claim.run_id === runId) ?? null;
  } catch {
    return null;
  }
}

/** `--json` output: indented for a terminal, one compact line when stdout is piped or captured. */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, process.stdout.isTTY ? 2 : 0)}\n`);
}

/**
 * Exit once stdout has drained. A bare process.exit() after a large piped write can cut the
 * output short. Never resolves, so the caller's remaining top-level code does not run.
 */
export function exitAfterFlush(code: number): Promise<never> {
  return new Promise<never>(() => {
    process.stdout.write('', () => process.exit(code));
  });
}

/** True when the project has neither an events database nor a legacy JSONL log to migrate; reading then must not create one. */
export function eventLogMissing(eventsDbPath: string): boolean {
  return !existsSync(eventsDbPath) && !existsSync(eventsDbPath.replace(/\.db$/, '.jsonl'));
}

export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cliError(error: unknown): never {
  console.error(`Error: ${formatErrorMessage(error)}`);
  process.exit(1);
}

/** Exit 1 with the no-project message when no project resolves, instead of reading the placeholder directory. */
export function requireProjectScope(): void {
  try {
    assertProjectScope();
  } catch (error) {
    cliError(error);
  }
}
