#!/usr/bin/env node
/**
 * cli/state-repair.ts
 * Usage: orc state-repair [--dry-run]
 *
 * Repairs known data invariant violations in the orchestrator state:
 *   1. Removes events with unknown event types from events.db
 *   2. Clears stale finalization_state on non-in_progress claims
 */
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { withLock } from '../lib/lock.ts';
import { atomicWriteJson } from '../lib/atomicWrite.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { readClaims } from '../lib/stateReader.ts';
import { readFileSync } from 'node:fs';

const dryRun = process.argv.includes('--dry-run');

const SCHEMA_DIR = join(import.meta.dirname, '..', 'schemas');
const EVENT_SCHEMA = JSON.parse(readFileSync(join(SCHEMA_DIR, 'event.schema.json'), 'utf8')) as {
  properties: { event: { enum: string[] } };
};
const KNOWN_EVENT_TYPES = new Set<string>(EVENT_SCHEMA.properties.event.enum);

let totalFixed = 0;

// --- Fix 1: remove unknown event types from events.db ---
{
  const dbPath = join(STATE_DIR, 'events.db');
  const db = new Database(dbPath);
  const rows = db.prepare(`SELECT seq, event FROM events`).all() as Array<{ seq: number; event: string }>;
  const unknownRows = rows.filter((r) => !KNOWN_EVENT_TYPES.has(r.event));

  if (unknownRows.length === 0) {
    console.log('events.db: no unknown event types found');
  } else {
    for (const row of unknownRows) {
      console.log(`events.db: ${dryRun ? '[dry-run] would remove' : 'removing'} seq=${row.seq} event="${row.event}"`);
    }
    if (!dryRun) {
      const del = db.prepare(`DELETE FROM events WHERE seq = ?`);
      const delFts = db.prepare(`DELETE FROM events_fts WHERE rowid = ?`);
      const deleteAll = db.transaction(() => {
        for (const row of unknownRows) {
          del.run(row.seq);
          delFts.run(row.seq);
        }
      });
      deleteAll();
      console.log(`events.db: removed ${unknownRows.length} row(s)`);
    }
    totalFixed += unknownRows.length;
  }
  db.close();
}

// --- Fix 2: clear stale finalization_state on non-in_progress claims ---
{
  const claimsPath = join(STATE_DIR, 'claims.json');
  withLock(join(STATE_DIR, '.lock'), () => {
    const claimsState = readClaims(STATE_DIR);
    const stale = claimsState.claims.filter(
      (c) => c.finalization_state != null && c.state !== 'in_progress',
    );

    if (stale.length === 0) {
      console.log('claims.json: no stale finalization_state found');
      return;
    }

    for (const c of stale) {
      console.log(
        `claims.json: ${dryRun ? '[dry-run] would clear' : 'clearing'} finalization_state="${String(c.finalization_state)}" on ${c.run_id} (state=${c.state})`,
      );
    }

    if (!dryRun) {
      for (const c of stale) {
        c.finalization_state = null;
        c.finalization_blocked_reason = null;
      }
      atomicWriteJson(claimsPath, claimsState);
      console.log(`claims.json: cleared finalization_state on ${stale.length} claim(s)`);
    }
    totalFixed += stale.length;
  });
}

if (dryRun) {
  console.log(`\ndry-run complete: ${totalFixed} issue(s) would be fixed`);
} else {
  console.log(`\nstate-repair complete: ${totalFixed} issue(s) fixed`);
}
