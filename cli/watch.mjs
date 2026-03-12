#!/usr/bin/env node
/**
 * cli/watch.mjs
 * Usage:
 *   node cli/watch.mjs [--interval-ms=5000] [--once]
 */
import { buildStatus, formatStatus } from '../lib/statusView.mjs';
import { STATE_DIR } from '../lib/paths.mjs';
import { validateStateDir } from '../lib/stateValidation.mjs';
import { flag, intFlag } from '../lib/args.mjs';

const once = process.argv.includes('--once') || (flag('once') ?? '') === 'true';
const intervalMs = intFlag('interval-ms', 5000);

function render() {
  const errors = validateStateDir(STATE_DIR);
  if (errors.length > 0) {
    console.error('State validation failed:');
    for (const e of errors) console.error(`  - ${e}`);
    return false;
  }
  try {
    const status = buildStatus(STATE_DIR);
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(formatStatus(status));
  } catch (err) {
    // buildStatus can fail transiently if coordinator is mid-write. Log and continue.
    console.error(`buildStatus error (may be transient): ${err.message}`);
    return false;
  }
  console.log('');
  console.log(`watch interval: ${intervalMs}ms`);
  console.log(`updated at: ${new Date().toISOString()}`);
  return true;
}

if (once) {
  const ok = render();
  process.exit(ok ? 0 : 1);
}

if (!render()) process.exit(1);

const timer = setInterval(() => {
  render();
}, intervalMs);

function shutdown() {
  clearInterval(timer);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
