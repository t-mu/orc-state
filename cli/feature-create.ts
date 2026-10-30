#!/usr/bin/env node
/**
 * cli/feature-create.ts
 * Usage:
 *   orc feature-create <ref> [--title=<text>]
 *
 * Creates a new feature in the backlog. Exits 0 if created, exits 1 if already exists.
 */
import { join } from 'node:path';
import { flag } from '../lib/args.ts';
import { withLock, lockPath } from '../lib/lock.ts';
import { atomicWriteJson } from '../lib/atomicWrite.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { readBacklog } from '../lib/stateReader.ts';
import { cliError } from './shared.ts';
import { isProjectStateDir } from '../lib/projectContext.ts';

const featureRef = process.argv[2];
if (!featureRef || featureRef.startsWith('--')) {
  console.error('Usage: orc feature-create <ref> [--title=<text>]');
  console.error('  ref must match [a-z0-9][a-z0-9-]*');
  process.exit(1);
}

if (!/^[a-z0-9][a-z0-9-]*$/.test(featureRef)) {
  console.error(`Invalid feature ref: ${featureRef}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  process.exit(1);
}

const title = flag('title') ?? featureRef.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

if (isProjectStateDir(STATE_DIR)) {
  // Project features are the ref prefixes of their tasks; there is no separate feature record.
  console.error('feature-create is not needed in a project state directory: create a task with --feature=<ref> instead.');
  process.exit(1);
}

try {
  withLock(lockPath(STATE_DIR), () => {
    const backlogPath = join(STATE_DIR, 'backlog.json');
    const backlog = readBacklog(STATE_DIR);

    if (backlog.features.some((e) => e.ref === featureRef)) {
      console.error(`feature already exists: ${featureRef}`);
      process.exit(1);
    }

    backlog.features = [...backlog.features, { ref: featureRef, title, tasks: [] }];
    atomicWriteJson(backlogPath, backlog);
    console.log(`feature created: ${featureRef} (${title})`);
  });
} catch (err) {
  cliError(err);
}
