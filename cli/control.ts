#!/usr/bin/env node
/**
 * cli/control.ts
 * Client for the local daemon control API.
 *
 * Usage:
 *   orc control snapshot
 *   orc control events [--after=<seq>] [--limit=<n>] [--follow] [--max-events=<n>]
 *   orc control command --run-id=<id> --recipient-session=<id> --kind=<kind>
 *     --idempotency-key=<key> [--payload=<json>] [--session-token=<id>]
 *   orc control ack <command_id> --state=<accepted|running|completed|failed> [--session-token=<id>]
 *
 * Mutations authenticate with the caller's running provider session ID, taken
 * from --session-token or ORC_SESSION_TOKEN.
 */
import { boolFlag, flag } from '../lib/args.ts';
import { ControlClient } from '../lib/controlClient.ts';
import { STATE_DIR } from '../lib/paths.ts';
import type { AckState } from '../lib/controlProtocol.ts';
import { cliError } from './shared.ts';

const [subcommand, ...positional] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

function seq(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) throw new Error(`--${name} must be a non-negative integer`);
  return value;
}

function required(name: string): string {
  const value = flag(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const client = new ControlClient(STATE_DIR, { sessionToken: flag('session-token') ?? process.env.ORC_SESSION_TOKEN ?? null });

try {
  if (subcommand === 'snapshot') {
    console.log(JSON.stringify(await client.snapshot(), null, 2));
  } else if (subcommand === 'events') {
    const after = seq('after', 0);
    if (boolFlag('follow')) {
      const max = seq('max-events', 0);
      let count = 0;
      for await (const row of client.subscribe(after)) {
        console.log(JSON.stringify(row));
        if (max > 0 && ++count >= max) break;
      }
    } else {
      console.log(JSON.stringify(await client.events(after, seq('limit', 100))));
    }
  } else if (subcommand === 'command') {
    const payload = flag('payload');
    let parsed: unknown = null;
    if (payload !== null) {
      try { parsed = JSON.parse(payload); } catch { throw new Error('--payload must be valid JSON'); }
    }
    const result = await client.submitCommand({
      run_id: required('run-id'),
      recipient_session_id: required('recipient-session'),
      idempotency_key: required('idempotency-key'),
      kind: required('kind'),
      payload: parsed,
    });
    console.log(JSON.stringify(result.command));
  } else if (subcommand === 'ack') {
    if (!positional[0]) throw new Error('Usage: orc control ack <command_id> --state=<state>');
    const result = await client.acknowledge(positional[0], required('state') as AckState);
    console.log(JSON.stringify(result.command));
  } else {
    throw new Error('Usage: orc control <snapshot|events|command|ack> [flags]');
  }
} catch (error) {
  cliError(error);
}
