import { describe, expect, it, vi } from 'vitest';
import { executeRunInputRequest } from './runCommands.ts';
import type { LifecycleRequest, LifecycleResult } from './workerLifecycle.ts';

describe('executeRunInputRequest', () => {
  it('stops without failing the run when it ended while waiting', async () => {
    const ops: string[] = [];
    const submit = vi.fn((request: LifecycleRequest): Promise<LifecycleResult> => {
      ops.push(request.op);
      if (request.op === 'input-request') return Promise.resolve({ message: 'asked', request_id: 'q-1', request_seq: 5, active: true });
      return Promise.resolve({ message: 'waiting', response: null, active: false });
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(executeRunInputRequest('run-a', 'worker-a', 'which way?', 60_000, 1, submit)).resolves.toBe(1);
    } finally {
      stderr.mockRestore();
      logged.mockRestore();
    }
    // A reaped session may poll, but input-timeout would be refused; there is nothing left to fail.
    expect(ops).not.toContain('input-timeout');
  });

  it('fails a still-active run once the wait times out', async () => {
    const ops: string[] = [];
    const submit = vi.fn((request: LifecycleRequest): Promise<LifecycleResult> => {
      ops.push(request.op);
      if (request.op === 'input-request') return Promise.resolve({ message: 'asked', request_id: 'q-1', request_seq: 5, active: true });
      return Promise.resolve({ message: 'waiting', response: null, active: true });
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(executeRunInputRequest('run-a', 'worker-a', 'which way?', 5, 1, submit)).resolves.toBe(1);
    } finally {
      stderr.mockRestore();
      logged.mockRestore();
    }
    expect(ops.at(-1)).toBe('input-timeout');
  });
});
