#!/usr/bin/env node
/**
 * cli/waiting-input.ts
 * Usage: orc waiting-input [--json]
 *
 * Show all claims currently awaiting input, with the question text.
 */
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { STATE_DIR } from '../lib/paths.ts';
import { readClaims } from '../lib/stateReader.ts';

const asJson = process.argv.includes('--json');
const now = Date.now();

const claimsState = readClaims(STATE_DIR);
const waiting = claimsState.claims.filter((c) => c.input_state === 'awaiting_input');

// Build map of run_id -> most recent input_requested event
const eventsPath = join(STATE_DIR, 'events.jsonl');
const questionMap = new Map<string, { question: string | null; ts: string | null }>();

if (existsSync(eventsPath)) {
  const lines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      if (ev.event === 'input_requested' && typeof ev.run_id === 'string') {
        const payload = ev.payload as Record<string, unknown> | undefined;
        questionMap.set(ev.run_id, {
          question: typeof payload?.question === 'string' ? payload.question : null,
          ts: typeof ev.ts === 'string' ? ev.ts : null,
        });
      }
    } catch {
      // skip malformed lines
    }
  }
}

const rows = waiting.map((c) => {
  const info = questionMap.get(c.run_id) ?? { question: null, ts: null };
  const waitingSec = info.ts ? Math.round((now - new Date(info.ts).getTime()) / 1000) : null;
  return {
    run_id: c.run_id,
    agent_id: c.agent_id,
    task_ref: c.task_ref,
    question: info.question,
    waiting_seconds: waitingSec,
    input_requested_at: info.ts,
  };
});

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

console.log(`Waiting for Input (${rows.length} runs):`);
if (rows.length === 0) {
  console.log('  (none)');
  process.exit(0);
}

for (const r of rows) {
  console.log(`  ${r.run_id}  agent=${r.agent_id}  task=${r.task_ref}  waiting=${r.waiting_seconds ?? '?'}s`);
  if (r.question) {
    console.log(`    question: ${r.question}`);
  }
}
