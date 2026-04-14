#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureNodePtySpawnHelperPermissions } from '../lib/nodePtyPermissions.ts';

export function isPackLikeCommand(env: NodeJS.ProcessEnv = process.env): boolean {
  const npmCommand = env.npm_command ?? '';
  return ['pack', 'publish'].includes(npmCommand) || env.npm_config_dry_run === 'true';
}

export function log(message: string, stream: NodeJS.WritableStream = process.stderr): void {
  stream.write(`[prepare] ${message}\n`);
}

export function runPrepare(env: NodeJS.ProcessEnv = process.env): void {
  const npmCommand = env.npm_command ?? '';
  if (isPackLikeCommand(env)) {
    log(`skipping git hook setup during npm ${npmCommand || 'pack/publish'} workflow`);
    return;
  }

  if (existsSync('.git')) {
    try {
      execFileSync('npx', ['simple-git-hooks'], { stdio: 'inherit' });
    } catch (error) {
      log(`warning: failed to install git hooks: ${(error as Error).message}`);
    }
  }

  ensureNodePtySpawnHelperPermissions();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPrepare();
}
