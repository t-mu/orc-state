import { Text } from 'ink';
import type { TuiFailureEntry } from './status.ts';

export function FailureAlert({
  failures,
}: {
  failures: { startup: TuiFailureEntry[]; lifecycle: TuiFailureEntry[] };
}) {
  const totalFailures = failures.startup.length + failures.lifecycle.length;
  if (totalFailures === 0) {
    return null;
  }

  return (
    <Text color="red" bold>
      failures detected: {totalFailures}
    </Text>
  );
}
