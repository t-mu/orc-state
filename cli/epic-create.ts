#!/usr/bin/env node
/**
 * cli/epic-create.ts
 * Usage:
 *   orc epic-create <ref> [--title=<text>]
 *
 * Creates a new epic in the backlog. Exits 0 if created, exits 1 if already exists.
 */
import { join } from 'node:path';
import { flag } from '../lib/args.ts';
import { withLock, lockPath } from '../lib/lock.ts';
import { atomicWriteJson } from '../lib/atomicWrite.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { readBacklog } from '../lib/stateReader.ts';

const epicRef = process.argv[2];
if (!epicRef || epicRef.startsWith('--')) {
  console.error('Usage: orc epic-create <ref> [--title=<text>]');
  console.error('  ref must match [a-z0-9][a-z0-9-]*');
  process.exit(1);
}

if (!/^[a-z0-9][a-z0-9-]*$/.test(epicRef)) {
  console.error(`Invalid epic ref: ${epicRef}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  process.exit(1);
}

const title = flag('title') ?? epicRef.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

try {
  withLock(lockPath(STATE_DIR), () => {
    const backlogPath = join(STATE_DIR, 'backlog.json');
    const backlog = readBacklog(STATE_DIR);

    if (backlog.epics.some((e) => e.ref === epicRef)) {
      console.error(`epic already exists: ${epicRef}`);
      process.exit(1);
    }

    backlog.epics = [...backlog.epics, { ref: epicRef, title, tasks: [] }];
    atomicWriteJson(backlogPath, backlog);
    console.log(`epic created: ${epicRef} (${title})`);
  });
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
