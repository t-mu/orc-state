import { describe, it, expect } from 'vitest';
import { HERMETIC_GIT_CONFIG_ARGS } from './gitPlumbing.ts';

describe('HERMETIC_GIT_CONFIG_ARGS', () => {
  // Pin the literal flags. Call-site tests import this same const, so they
  // cannot catch a regression in the const itself (emptied, reordered, or a
  // corrupted flag value) — only a divergence between production code and the
  // const. This test guards the actual hermetic behaviour B4 depends on.
  it('disables hooks and fsmonitor, with -c flags preceding the subcommand', () => {
    expect([...HERMETIC_GIT_CONFIG_ARGS]).toEqual([
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
    ]);
  });
});
