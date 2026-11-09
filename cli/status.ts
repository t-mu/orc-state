#!/usr/bin/env node
/**
 * cli/status.ts
 * Usage: node cli/status.ts [--json] [--mine --agent-id=<id>]
 *                           [--events=<0-200>]  (recentEvents in --json; default 20)
 *                           [--watch [-w] [--interval-ms=5000] [--once]]
 *
 * --watch / -w  Live-refresh mode: clears screen and re-renders on interval.
 * --once        Render exactly one frame and exit (useful for testing watch mode).
 * --json with --once/--watch prints one compact JSON document per line (NDJSON), no screen-clear codes.
 * --interval-ms Polling interval in ms (default 5000). Only relevant with --watch.
 */
import { parseCommandArgsOrExit } from '../lib/args.ts';
import { buildAgentStatus, buildStatus as buildStatusView, DEFAULT_STATUS_EVENTS, MAX_STATUS_EVENTS, withProjectSelection } from '../lib/statusView.ts';
import { renderBanner } from '../lib/banner.ts';
import { colorFormatAgentStatus, colorFormatStatus } from '../lib/colorStatus.ts';
import { ACTIVE_PROJECT, STATE_DIR } from '../lib/paths.ts';
import { coordinatorSummary } from '../lib/coordinatorProcess.ts';
import { partitionValidationErrors, validateStateDir } from '../lib/stateValidation.ts';
import { exitAfterFlush, formatErrorMessage, printJson, requireProjectScope } from './shared.ts';
import { USAGE } from './usage.ts';

const { values } = parseCommandArgsOrExit(USAGE['status'], {
  json: { type: 'boolean' },
  mine: { type: 'boolean' },
  'agent-id': { type: 'string' },
  watch: { type: 'boolean', short: 'w' },
  once: { type: 'boolean' },
  'interval-ms': { type: 'string' },
  events: { type: 'string' },
});
requireProjectScope();
const json = values.json === true;
const mine = values.mine === true;
const agentId = values['agent-id'];
const watch = values.watch === true;
const once = values.once === true;
const intervalRaw = values['interval-ms'];
if (intervalRaw !== undefined && !/^[1-9]\d*$/.test(intervalRaw)) {
  console.error(`--interval-ms must be a positive integer\nUsage: ${USAGE['status']}`);
  process.exit(1);
}
const intervalMs = intervalRaw === undefined ? 5000 : Number(intervalRaw);
// Clear-screen codes only make sense on a terminal, and never in JSON frames.
const clearScreen = process.stdout.isTTY === true && !json;

const eventsRaw = values.events;
const events = eventsRaw == null ? DEFAULT_STATUS_EVENTS : Number(eventsRaw);
if (eventsRaw != null && (!/^\d+$/.test(eventsRaw) || events > MAX_STATUS_EVENTS)) {
  console.error(`--events must be an integer from 0 to ${MAX_STATUS_EVENTS}\nUsage: ${USAGE['status']}`);
  process.exit(1);
}

if (mine && !agentId) {
  console.error(`--mine requires --agent-id\nUsage: ${USAGE['status']}`);
  process.exit(1);
}

// The status names the project and how this command selected it.
const buildStatus = (...args: Parameters<typeof buildStatusView>) => withProjectSelection(buildStatusView(...args), ACTIVE_PROJECT);

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
      printJson(agentStatus);
      printValidationWarnings(warnings);
    } else {
      if (process.stdout.isTTY) console.log(renderBanner());
      console.log(colorFormatAgentStatus(agentStatus, agentId as string));
      printValidationWarnings(warnings);
    }
    await exitAfterFlush(0);
  }

  const status = buildStatus(STATE_DIR, { events });
  if (json) {
    // Same coordinator fields as MCP get_status.
    printJson({ ...status, coordinator: await coordinatorSummary(STATE_DIR) });
    printValidationWarnings(warnings);
  } else {
    if (process.stdout.isTTY) console.log(renderBanner());
    console.log(colorFormatStatus(status));
    printValidationWarnings(warnings);
  }
  await exitAfterFlush(0);
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
    if (json) {
      if (mine) {
        const agentStatus = buildAgentStatus(STATE_DIR, agentId as string);
        if (!agentStatus.agent) {
          console.error(`Agent not found: ${agentId}`);
          return false;
        }
        process.stdout.write(`${JSON.stringify(agentStatus)}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(buildStatus(STATE_DIR, { events }))}\n`);
      }
      printValidationWarnings(warnings);
      return true;
    }
    if (clearScreen) process.stdout.write('\x1b[2J\x1b[H');
    if (process.stdout.isTTY) console.log(renderBanner());
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
  await exitAfterFlush(ok ? 0 : 1);
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
