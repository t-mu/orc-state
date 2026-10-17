#!/usr/bin/env node
/**
 * cli/sessions.ts
 * Usage: orc sessions [--all] [--json]
 *
 * List supervised provider sessions with their state and recovery reason.
 * Without --all, offline sessions are hidden.
 */
import { boolFlag } from '../lib/args.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { listSupervisedSessions } from '../lib/sessionSupervisor.ts';

const sessions = listSupervisedSessions(STATE_DIR, boolFlag('all') ? undefined : ['running', 'recoverable', 'unknown']);

if (boolFlag('json')) {
  console.log(JSON.stringify({ total: sessions.length, sessions }, null, 2));
  process.exit(0);
}

console.log(`Sessions: ${sessions.length}`);
if (sessions.length === 0) console.log('(none)');
for (const s of sessions) {
  console.log(`${s.session_id} ${s.agent_id} state=${s.state} transport=${s.transport ?? '?'} pid=${s.process_pid ?? '?'} run=${s.run_id ?? '-'} owner=${s.owner_id ?? '-'}`);
  if (s.state_reason) console.log(`  reason: ${s.state_reason}`);
}
