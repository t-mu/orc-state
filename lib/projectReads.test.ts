import { describe, expect, it, vi } from 'vitest';
import type { ControlClient } from './controlClient.ts';
import { ControlError } from './controlProtocol.ts';
import { readMemoryWakeUp, readViaCoordinator } from './projectReads.ts';

const client = () => ({}) as ControlClient;

describe('readViaCoordinator (task 230)', () => {
  it('reads a legacy installation directly', async () => {
    const remote = vi.fn();
    await expect(readViaCoordinator(remote, () => 'local', { project: null, client })).resolves.toBe('local');
    expect(remote).not.toHaveBeenCalled();
  });

  it('asks the running coordinator of a project', async () => {
    const local = vi.fn();
    await expect(readViaCoordinator(() => Promise.resolve('remote'), local, { project: 'p', client })).resolves.toBe('remote');
    expect(local).not.toHaveBeenCalled();
  });

  it('falls back to the state directory only while the coordinator is unavailable', async () => {
    const unavailable = () => Promise.reject(new ControlError('unavailable', 'Control daemon is not running', 503));
    await expect(readViaCoordinator(unavailable, () => 'local', { project: 'p', client })).resolves.toBe('local');
    // A coordinator from before the read routes answers 404: read directly too.
    const stale = () => Promise.reject(new ControlError('not_found', 'No route for GET /v1/runs/r/reviews', 404));
    await expect(readViaCoordinator(stale, () => 'local', { project: 'p', client })).resolves.toBe('local');
    // A sandbox refusing the socket, or a timeout, is reported rather than hidden behind a direct read.
    const forbidden = () => Promise.reject(new ControlError('forbidden', 'Connecting to the control socket was refused (EPERM)', 403));
    await expect(readViaCoordinator(forbidden, () => 'local', { project: 'p', client })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(readViaCoordinator(() => Promise.reject(new Error('Control request timed out')), () => 'local', { project: 'p', client }))
      .rejects.toThrow('Control request timed out');
  });

  it('reports a failed fallback as retryable', async () => {
    const unavailable = () => Promise.reject(new ControlError('unavailable', 'Control daemon is not running', 503));
    const local = () => { throw new Error('attempt to write a readonly database'); };
    await expect(readViaCoordinator(unavailable, local, { project: 'p', client })).rejects.toThrow(
      'The coordinator is not running and the project state could not be read directly (attempt to write a readonly database); retry once the coordinator is running',
    );
  });

  it('tells a stale coordinator apart from a stopped one when the direct read fails too', async () => {
    const stale = () => Promise.reject(new ControlError('not_found', 'No route', 404));
    const local = () => { throw new Error('locked'); };
    await expect(readViaCoordinator(stale, local, { project: 'p', client })).rejects.toThrow('restart the coordinator on this orc version');
  });

  it('validates the wake-up budget the same way on every path', () => {
    expect(() => readMemoryWakeUp('/nonexistent', { budget: 0 })).toThrow('budget must be a positive integer');
    expect(readMemoryWakeUp('/nonexistent', { budget: 1 })).toEqual({ initialized: false, text: '' });
  });
});
