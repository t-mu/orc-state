#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const npmCommand = process.env.npm_command ?? '';
const isPackLikeCommand = ['pack', 'publish'].includes(npmCommand) || process.env.npm_config_dry_run === 'true';

function log(message: string) {
  console.log(`[prepare] ${message}`);
}

if (isPackLikeCommand) {
  log(`skipping git hook setup during npm ${npmCommand || 'pack/publish'} workflow`);
  process.exit(0);
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
