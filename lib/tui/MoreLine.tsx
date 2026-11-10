import { Text } from 'ink';

/** The "+N more" line under a truncated list; nothing when no items are hidden. */
export function MoreLine({ hidden, label = 'more' }: { hidden: number; label?: string }) {
  return hidden > 0 ? <Text dimColor wrap="truncate">{`  +${hidden} ${label}`}</Text> : null;
}
