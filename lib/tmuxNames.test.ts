import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmuxSessionName, tmuxSessionTarget, tmuxSocketName } from './tmuxNames.ts';

describe('tmuxNames', () => {
  it('imports only node built-ins', () => {
    const source = readFileSync(join(import.meta.dirname, 'tmuxNames.ts'), 'utf8');
    const specifiers = [...source.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(specifiers).toEqual(['node:crypto']);
  });

  it('computes the socket name from the state directory', () => {
    expect(tmuxSocketName('/tmp/state')).toBe('orc-499762b5a20e');
  });

  it('computes readable, injective session names', () => {
    expect(tmuxSessionName('master')).toBe('orc-master-fc613b4d');
    expect(tmuxSessionName('a.b')).toBe('orc-a_b-2e7336dc');
    expect(tmuxSessionName('a_b')).toBe('orc-a_b-648fa9b3');
    expect(tmuxSessionName('x'.repeat(50))).toBe(`orc-${'x'.repeat(40)}-77cf1206`);
  });

  it('computes the target when provider_ref records none', () => {
    const computed = { socket: 'orc-499762b5a20e', session: 'orc-master-fc613b4d' };
    expect(tmuxSessionTarget('/tmp/state', 'master')).toEqual(computed);
    expect(tmuxSessionTarget('/tmp/state', 'master', null)).toEqual(computed);
    expect(tmuxSessionTarget('/tmp/state', 'master', { tmux_socket: '', tmux_session: 7 })).toEqual(computed);
  });

  it('prefers the socket and session recorded in provider_ref', () => {
    expect(tmuxSessionTarget('/tmp/state', 'master', { tmux_socket: 'orc-old', tmux_session: 'orc-master-old' }))
      .toEqual({ socket: 'orc-old', session: 'orc-master-old' });
    expect(tmuxSessionTarget('/tmp/state', 'master', { tmux_session: 'orc-master-old' }))
      .toEqual({ socket: 'orc-499762b5a20e', session: 'orc-master-old' });
  });
});
