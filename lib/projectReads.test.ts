import { describe, expect, it, vi } from 'vitest';
import type { ControlClient } from './controlClient.ts';
import { ControlError } from './controlProtocol.ts';
import { readProjectState } from './projectReads.ts';

const client = () => ({}) as ControlClient;

describe('readProjectState (task 230)', () => {
  it('reads a legacy installation directly', async () => {
    const remote = vi.fn();
    await expect(readProjectState(remote, () => 'local', { project: null, client })).resolves.toBe('local');
    expect(remote).not.toHaveBeenCalled();
  });

  it('asks the running coordinator of a project', async () => {
    const local = vi.fn();
    await expect(readProjectState(() => Promise.resolve('remote'), local, { project: 'p', client })).resolves.toBe('remote');
    expect(local).not.toHaveBeenCalled();
  });

  it('falls back to the state directory only while the coordinator is unavailable', async () => {
    const unavailable = () => Promise.reject(new ControlError('unavailable', 'Control daemon is not running', 503));
    await expect(readProjectState(unavailable, () => 'local', { project: 'p', client })).resolves.toBe('local');
    const forbidden = () => Promise.reject(new ControlError('forbidden', 'no', 403));
    await expect(readProjectState(forbidden, () => 'local', { project: 'p', client })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('reports a failed fallback as retryable', async () => {
    const unavailable = () => Promise.reject(new ControlError('unavailable', 'Control daemon is not running', 503));
    const local = () => { throw new Error('attempt to write a readonly database'); };
    await expect(readProjectState(unavailable, local, { project: 'p', client })).rejects.toThrow(
      'The coordinator is not running and the project state could not be read directly (attempt to write a readonly database); retry once the coordinator is running',
    );
  });
});
