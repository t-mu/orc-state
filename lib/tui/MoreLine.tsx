import { Text } from 'ink';

/** The "+N more" line under a truncated list; nothing when no items are hidden. */
export function MoreLine({ hidden }: { hidden: number }) {
  return hidden > 0 ? <Text dimColor>{`  +${hidden} more`}</Text> : null;
}
