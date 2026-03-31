import { STATE_DIR } from '../lib/paths.ts';
import { readClaims } from '../lib/stateReader.ts';
import type { Claim } from '../types/claims.ts';

export function loadClaim(runId: string): Claim | null {
  try {
    return readClaims(STATE_DIR).claims.find((claim) => claim.run_id === runId) ?? null;
  } catch {
    return null;
  }
}

export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cliError(error: unknown): never {
  console.error(`Error: ${formatErrorMessage(error)}`);
  process.exit(1);
}
