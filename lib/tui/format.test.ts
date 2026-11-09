import { describe, expect, it } from 'vitest';
import { formatProjectIdentity as statusIdentity } from '../projectHealth.ts';
import { WAITING_INPUT_ANSWER_HINT as statusHint } from '../waitingInput.ts';
import { formatProjectIdentity, WAITING_INPUT_ANSWER_HINT } from './format.ts';

describe('lib/tui/format', () => {
  it('keeps the answer hint orc status prints', () => {
    expect(WAITING_INPUT_ANSWER_HINT).toBe(statusHint);
  });

  it('formats the project identity as orc status does', () => {
    const project = { id: 'p1', name: 'demo', target_repo_root: '/repo' };
    expect(formatProjectIdentity(project)).toBe(statusIdentity(project));
    expect(formatProjectIdentity(null)).toBe(statusIdentity(null));
  });
});
