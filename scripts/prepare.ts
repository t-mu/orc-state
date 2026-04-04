#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  const spawnHelper = join('node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper');
  if (existsSync(spawnHelper)) {
    try {
      chmodSync(spawnHelper, 0o755);
    } catch (error) {
      log(`warning: failed to chmod ${spawnHelper}: ${(error as Error).message}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPrepare();
}
