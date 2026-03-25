#!/usr/bin/env node
/**
 * cli/watch.ts
 * Usage:
 *   node cli/watch.ts [--interval-ms=5000] [--once]
 */
import { buildStatus } from '../lib/statusView.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { validateStateDir } from '../lib/stateValidation.ts';
import { flag, intFlag } from '../lib/args.ts';
import { renderBanner } from '../lib/banner.ts';
import { colorFormatStatus } from '../lib/colorStatus.ts';
import { partitionValidationErrors } from '../lib/stateValidation.ts';

const once = process.argv.includes('--once') || (flag('once') ?? '') === 'true';
const intervalMs = intFlag('interval-ms', 5000);

function render() {
  const { fatal, warnings } = partitionValidationErrors(validateStateDir(STATE_DIR));
  if (fatal.length > 0) {
    console.error('State validation failed:');
    for (const error of fatal) console.error(`  - ${error}`);
    return false;
  }
  try {
    const status = buildStatus(STATE_DIR);
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(renderBanner());
    console.log(colorFormatStatus(status));
    if (warnings.length > 0) {
      console.log('');
      console.log('State validation warnings:');
      for (const warning of warnings) console.log(`  - ${warning}`);
    }
  } catch (err) {
    // buildStatus can fail transiently if coordinator is mid-write. Log and continue.
    console.error(`buildStatus error (may be transient): ${(err as Error).message}`);
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
