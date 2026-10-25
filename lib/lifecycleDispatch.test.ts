import { describe, expect, it, vi } from 'vitest';
import { ControlError } from './controlProtocol.ts';
import { sendLifecycle } from './lifecycleDispatch.ts';

const request = { op: 'run-start', run_id: 'run-1', agent_id: 'worker-1' } as const;

describe('sendLifecycle', () => {
  it('retries while the coordinator is unavailable, warning once', async () => {
    const lifecycle = vi.fn()
      .mockRejectedValueOnce(new ControlError('unavailable', 'Control daemon is not running', 503))
      .mockRejectedValueOnce(new ControlError('unavailable', 'Control daemon is shutting down', 503))
      .mockResolvedValue({ message: 'run_started: run-1 (worker-1)' });
    const warn = vi.fn();
    await expect(sendLifecycle({ lifecycle }, request, { retryMs: 5_000, intervalMs: 1, warn })).resolves.toEqual({ message: 'run_started: run-1 (worker-1)' });
    expect(lifecycle).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry window', async () => {
    const lifecycle = vi.fn().mockRejectedValue(new ControlError('unavailable', 'Control daemon is not running', 503));
    await expect(sendLifecycle({ lifecycle }, request, { retryMs: 0, intervalMs: 1, warn: () => {} })).rejects.toMatchObject({ code: 'unavailable' });
    expect(lifecycle).toHaveBeenCalledTimes(1);
  });

  it('never retries a request the coordinator may have applied', async () => {
    for (const error of [new ControlError('conflict', 'Run not found in claims: run-1', 409), new Error('Control request timed out')]) {
      const lifecycle = vi.fn().mockRejectedValue(error);
      await expect(sendLifecycle({ lifecycle }, request, { retryMs: 5_000, intervalMs: 1, warn: () => {} })).rejects.toBe(error);
      expect(lifecycle).toHaveBeenCalledTimes(1);
    }
  });
});
