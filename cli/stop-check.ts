#!/usr/bin/env node
/**
 * cli/stop-check.ts
 * Usage: orc stop-check   (reads Claude's Stop hook input JSON on stdin)
 *
 * Installed as a Claude worker's `Stop` hook. Asks the coordinator whether
 * this session's run lets it end its turn and prints a `decision: "block"`
 * object when it does not. Always exits 0; fails open (see lib/stopHook.ts).
 */
import { stopHookOutput } from '../lib/stopHook.ts';

/** Stays well under Claude's hook timeout, so the stop is allowed rather than the hook killed. */
const STOP_CHECK_TIMEOUT_MS = 5_000;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  // Imported here, not statically: resolving the project may throw, and the hook must still fail open.
  const { ControlClient } = await import('../lib/controlClient.ts');
  const { STATE_DIR } = await import('../lib/paths.ts');
  const { clientCredential } = await import('../lib/sessionCredentials.ts');
  const credential = clientCredential();
  const check = credential
    ? (stopHookActive: boolean) => new ControlClient(STATE_DIR, { credential, timeoutMs: STOP_CHECK_TIMEOUT_MS }).stopCheck(stopHookActive)
    : null;
  const output = await stopHookOutput(await readStdin(), check);
  if (output) console.log(output);
} catch {
  // Fail open: resolving the state directory or reading stdin failed.
}
process.exit(0);
