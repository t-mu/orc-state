#!/usr/bin/env node
/**
 * cli/status.ts
 * Usage: node cli/status.ts [--json] [--mine --agent-id=<id>]
 *                           [--watch [-w] [--interval-ms=5000] [--once]]
 *
 * --watch / -w  Live-refresh mode: clears screen and re-renders on interval.
 * --once        Render exactly one frame and exit (useful for testing watch mode).
 * --interval-ms Polling interval in ms (default 5000). Only relevant with --watch.
 */
import { boolFlag, flag, intFlag } from '../lib/args.ts';
import { buildAgentStatus, buildStatus } from '../lib/statusView.ts';
import { renderBanner } from '../lib/banner.ts';
import { colorFormatAgentStatus, colorFormatStatus } from '../lib/colorStatus.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { partitionValidationErrors, validateStateDir } from '../lib/stateValidation.ts';
import { formatErrorMessage } from './shared.ts';

const json = boolFlag('json');
const mine = boolFlag('mine');
const agentId = flag('agent-id');
const watch = boolFlag('watch') || process.argv.includes('-w');
const once = boolFlag('once');
const intervalMs = intFlag('interval-ms', 5000);

if (mine && !agentId) {
  console.error('Usage: orc status --mine --agent-id=<id> [--json]');
  process.exit(1);
}

function printValidationWarnings(warnings: string[]) {
  if (warnings.length === 0) return;
  console.warn('State validation warnings:');
  for (const warning of warnings) console.warn(`  - ${warning}`);
}

// ── Non-watch path (original single-shot behavior) ───────────────────────────

if (!watch && !once) {
  const { fatal, warnings } = partitionValidationErrors(validateStateDir(STATE_DIR));
  if (fatal.length > 0) {
    console.error('State validation failed:');
    for (const error of fatal) console.error(' ', error);
    process.exit(1);
  }

  if (mine) {
    const agentStatus = buildAgentStatus(STATE_DIR, agentId as string);
    if (!agentStatus.agent) {
      console.error(`Agent not found: ${agentId}`);
      process.exit(1);
    }
    if (json) {
      console.log(JSON.stringify(agentStatus, null, 2));
      printValidationWarnings(warnings);
    } else {
      console.log(renderBanner());
      console.log(colorFormatAgentStatus(agentStatus, agentId as string));
      printValidationWarnings(warnings);
    }
    process.exit(0);
  }

  const status = buildStatus(STATE_DIR);
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    printValidationWarnings(warnings);
  } else {
    console.log(renderBanner());
    console.log(colorFormatStatus(status));
    printValidationWarnings(warnings);
  }
  process.exit(0);
}

// ── Watch path ────────────────────────────────────────────────────────────────

function render(): boolean {
  const { fatal, warnings } = partitionValidationErrors(validateStateDir(STATE_DIR));
  if (fatal.length > 0) {
    console.error('State validation failed:');
    for (const error of fatal) console.error(`  - ${error}`);
    return false;
  }
  try {
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(renderBanner());
    if (mine) {
      const agentStatus = buildAgentStatus(STATE_DIR, agentId as string);
      if (!agentStatus.agent) {
        console.error(`Agent not found: ${agentId}`);
        return false;
      }
      console.log(colorFormatAgentStatus(agentStatus, agentId as string));
    } else {
      const status = buildStatus(STATE_DIR);
      console.log(colorFormatStatus(status));
    }
    if (warnings.length > 0) {
      console.log('');
      console.log('State validation warnings:');
      for (const warning of warnings) console.log(`  - ${warning}`);
    }
  } catch (err) {
    // buildStatus can fail transiently if coordinator is mid-write. Log and continue.
    console.error(`buildStatus error (may be transient): ${formatErrorMessage(err)}`);
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
