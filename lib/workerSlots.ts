export function isManagedSlot(agentId: string | null | undefined, maxWorkers: number): boolean {
  const match = /^orc-(\d+)$/.exec(agentId ?? '');
  if (!match) return false;
  const slotNumber = Number(match[1]);
  return Number.isInteger(slotNumber) && slotNumber >= 1 && slotNumber <= maxWorkers;
}
