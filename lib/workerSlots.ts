/**
 * LEGACY — coordinator session-retry path only.
 *
 * Returns true for agents with the legacy `orc-N` naming format. These were
 * previously synthesised by `reconcileManagedWorkerSlots` (now removed) and
 * received automatic session-start retries. New ephemeral workers use
 * deterministic two-word names (e.g. `amber-anchor`) and return false here,
 * which causes the coordinator to fail-and-requeue on session start failures —
 * the correct behaviour for externally-launched ephemeral workers.
 *
 * TODO: remove this file once the coordinator's isManagedSlot call-sites are
 * updated to reflect the unified ephemeral-worker lifecycle.
 */
export function isManagedSlot(agentId: string | null | undefined, maxWorkers: number): boolean {
  const match = /^orc-(\d+)$/.exec(agentId ?? '');
  if (!match) return false;
  const slotNumber = Number(match[1]);
  return Number.isInteger(slotNumber) && slotNumber >= 1 && slotNumber <= maxWorkers;
}
