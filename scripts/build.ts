#!/usr/bin/env node
/**
 * scripts/build.ts
 *
 * Compiles all non-test .ts/.tsx source files to dist/ as ESM .js,
 * preserving directory structure. Dependencies are external (resolved
 * from node_modules at runtime).
 *
 * Also runs tsc --project tsconfig.build.json for .d.ts declarations.
 */
import { execSync } from 'node:child_process';
import { cpSync, globSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { buildSync } from 'esbuild';

const allFiles = globSync([
  'index.ts',
  'coordinator.ts',
  'cli/**/*.ts',
  'lib/**/*.ts',
  'lib/**/*.tsx',
  'mcp/**/*.ts',
  'adapters/**/*.ts',
  'types/**/*.ts',
]);

const entryPoints = allFiles.filter(
  (f: string) => !f.includes('.test.') && !f.startsWith('test-fixtures/'),
);

console.log(`esbuild: compiling ${entryPoints.length} files to dist/`);

// Start from a clean dist/ tree so removed source assets do not linger in the
// published tarball across builds.
rmSync('dist', { recursive: true, force: true });

buildSync({
  entryPoints,
  outdir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node24',
  jsx: 'automatic',
  jsxImportSource: 'react',
  packages: 'external',
  outExtension: { '.js': '.js' },
  sourcemap: false,
});

// Rewrite .ts/.tsx import specifiers to .js in emitted files
const outputFiles = globSync('dist/**/*.js');
let rewritten = 0;
for (const file of outputFiles) {
  const content = readFileSync(file, 'utf8');
  // Rewrite relative .ts/.tsx references in emitted JS so dynamic imports,
  // new URL() calls, and other runtime string literals resolve inside dist/.
  const updated = content
    .replace(/(from\s+["']\..*?)\.tsx?(["'])/g, '$1.js$2')
    .replace(/(["'])(\.\.?\/[^"']+)\.tsx?(["'])/g, '$1$2.js$3')
    .replace(/(["'])([a-z][-a-z0-9]*)\.ts(["'])/g, '$1$2.js$3');
  if (updated !== content) {
    writeFileSync(file, updated);
    rewritten++;
  }
}
console.log(`  rewrote .ts imports → .js in ${rewritten} files`);

// Copy non-TS assets that are resolved via import.meta.dirname
for (const dir of ['schemas', 'templates', 'skills', 'agents']) {
  cpSync(dir, `dist/${dir}`, { recursive: true });
}
// Strip package-irrelevant source metadata and scratch workspace content from
// the published tarball.
rmSync('dist/skills/.npmignore', { force: true });
rmSync('dist/skills/plan-to-tasks-workspace', { recursive: true, force: true });
rmSync('dist/skills/plan-to-tasks/evals', { recursive: true, force: true });
console.log('  copied schemas/, templates/, skills/, and agents/ into dist/');

console.log('tsc: emitting declarations to dist/');

execSync('npx tsc --project tsconfig.build.json', { stdio: 'inherit' });

// Remove empty .d.ts files (CLI subcommands that export nothing)
const dtsFiles = globSync('dist/**/*.d.ts');
let removed = 0;
for (const f of dtsFiles) {
  const content = readFileSync(f, 'utf8').trim();
  if (content === 'export {};' || content === '' || content === '#!/usr/bin/env node\nexport {};') {
    unlinkSync(f);
    removed++;
  }
}
console.log(`  removed ${removed} empty .d.ts files`);

// Remove empty runtime .js stubs emitted for type-only modules. They add noise
// to the published tarball and are not useful to consumers.
const jsFiles = globSync('dist/**/*.js');
let removedJs = 0;
for (const f of jsFiles) {
  if (statSync(f).size === 0) {
    unlinkSync(f);
    removedJs++;
  }
}
console.log(`  removed ${removedJs} empty .js files`);

console.log('build complete');
