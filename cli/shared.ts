import { existsSync } from 'node:fs';
import { assertProjectScope, STATE_DIR } from '../lib/paths.ts';
import { readClaims } from '../lib/stateReader.ts';
import { ControlError, type ControlErrorCode } from '../lib/controlProtocol.ts';
import { ConflictError, InputError, NotFoundError } from '../lib/domainErrors.ts';
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

/** Exit code of a `--json` failure that may succeed when retried (`unavailable`, `busy`); other failures exit 1 (sysexits EX_TEMPFAIL). */
export const EXIT_RETRYABLE = 75;

/** The control-API error code of a failure, whether it came back from the coordinator or was raised by the direct path. */
export function errorCode(error: unknown): ControlErrorCode {
  if (error instanceof ControlError) return error.code;
  if (error instanceof NotFoundError) return 'not_found';
  if (error instanceof ConflictError) return 'conflict';
  if (error instanceof InputError) return 'bad_request';
  return 'internal';
}

export function isRetryableCode(code: string): boolean {
  return code === 'unavailable' || code === 'busy';
}

/** Print `{ error: { code, message } }` on stdout and exit: 75 for a retryable code, else 1. */
export function exitWithJsonError(code: string, message: string): Promise<never> {
  printJson({ error: { code, message } });
  return exitAfterFlush(isRetryableCode(code) ? EXIT_RETRYABLE : 1);
}

/** Report a failed command: a `--json` error object, or the usual `Error:` line on stderr with exit 1. */
export function failCommand(error: unknown, json: boolean): Promise<never> | never {
  if (json) return exitWithJsonError(errorCode(error), formatErrorMessage(error));
  return cliError(error);
}
