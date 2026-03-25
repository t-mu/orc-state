#!/usr/bin/env -S node --experimental-strip-types
/**
 * cli/notifications-clear.ts
 * Usage: orc notifications-clear
 *
 * Marks all pending (unconsumed) master notifications as consumed.
 */
import { STATE_DIR } from '../lib/paths.ts';
import { clearNotifications } from '../lib/masterNotifyQueue.ts';

const count = clearNotifications(STATE_DIR);
if (count === 0) {
  console.log('No pending notifications to clear.');
} else {
  console.log(`Cleared ${count} notification${count === 1 ? '' : 's'}.`);
}
