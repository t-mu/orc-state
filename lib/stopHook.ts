/**
 * The hook side of the stop-hook run guard (general/stop-hook-run-guard).
 * Claude runs `orc stop-check` as a worker's `Stop` hook with the hook input
 * JSON on stdin. The coordinator decides (lib/stopCheck.ts); this only
 * relays the answer in Claude's hook output format. Every failure — no
 * session, unreadable input, an unreachable or refusing coordinator — allows
 * the stop: a broken guard must never wedge a worker.
 */
export type StopCheck = (stopHookActive: boolean) => Promise<{ allow: boolean; reason?: string }>;

/** Parse Claude's Stop hook input; anything unreadable counts as a first, unblocked stop. */
export function parseStopHookInput(text: string): { stopHookActive: boolean } {
  try {
    const input = JSON.parse(text) as { stop_hook_active?: unknown } | null;
    return { stopHookActive: input?.stop_hook_active === true };
  } catch {
    return { stopHookActive: false };
  }
}

/**
 * The hook's stdout: a `decision: "block"` object when the coordinator blocks
 * the stop, otherwise null (print nothing, exit 0, and Claude stops).
 */
export async function stopHookOutput(stdinText: string, check: StopCheck | null): Promise<string | null> {
  if (!check) return null;
  const { stopHookActive } = parseStopHookInput(stdinText);
  try {
    const result = await check(stopHookActive);
    if (result.allow || !result.reason) return null;
    return JSON.stringify({ decision: 'block', reason: result.reason });
  } catch {
    return null;
  }
}
