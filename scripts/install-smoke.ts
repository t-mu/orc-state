#!/usr/bin/env node
/**
 * scripts/install-smoke.ts
 *
 * Fresh-install smoke test — proves the published tarball actually works
 * when installed into a clean consumer project.
 *
 * Steps:
 *   1. npm pack (produce the tarball that would be published)
 *   2. mkdtemp — create a fresh throwaway project
 *   3. npm init -y
 *   4. npm install <tarball>
 *   5. ./node_modules/.bin/orc --help   — verify binary resolves and runs
 *   6. ./node_modules/.bin/orc doctor   — verify CLI commands execute
 *   7. cleanup
 *
 * This is stronger than pack-smoke (which symlinks repo node_modules) because
 * it validates that the tarball's declared dependencies are actually sufficient
 * for a fresh npm install with no repo-side assumptions.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = join(import.meta.dirname, '..');

function run(cmd: string, args: string[], cwd: string, extra: Record<string, unknown> = {}): string {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...extra });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout ?? '';
}

function findTarball(dir: string): string {
  const files = readdirSync(dir).filter((f) => f.startsWith('orc-state-') && f.endsWith('.tgz'));
  if (files.length === 0) throw new Error('no orc-state tarball found');
  if (files.length > 1) throw new Error(`multiple tarballs found: ${files.join(', ')}`);
  return join(dir, files[0]);
}

function main(): void {
  let tarballPath = '';
  let tmpProject = '';
  try {
    console.log('1. packing tarball...');
    run('npm', ['pack'], repoRoot);
    tarballPath = findTarball(repoRoot);
    console.log(`   → ${tarballPath}`);

    console.log('2. creating fresh project...');
    tmpProject = mkdtempSync(join(tmpdir(), 'orc-install-smoke-'));
    run('npm', ['init', '-y'], tmpProject);

    console.log('3. installing tarball...');
    run('npm', ['install', tarballPath], tmpProject);

    console.log('4. testing orc --help...');
    const help = run('./node_modules/.bin/orc', ['--help'], tmpProject);
    if (!help.includes('Usage: orc')) throw new Error(`orc --help did not print expected usage: ${help}`);

    console.log('5. testing orc doctor...');
    // doctor exits 1 if provider binaries missing — that's expected in a fresh temp project.
    // Accept any exit; just verify it runs without crashing.
    const result = spawnSync('./node_modules/.bin/orc', ['doctor'], { cwd: tmpProject, encoding: 'utf8' });
    if (result.stdout.length === 0 && result.stderr.length === 0) {
      throw new Error('orc doctor produced no output');
    }
    if (!result.stdout.includes('Doctor') && !result.stderr.includes('Doctor')) {
      throw new Error(`orc doctor did not produce expected output: ${result.stdout} / ${result.stderr}`);
    }

    console.log('install smoke ok');
  } finally {
    if (tarballPath) rmSync(tarballPath, { force: true });
    if (tmpProject) rmSync(tmpProject, { recursive: true, force: true });
  }
}

main();
