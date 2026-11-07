import { describe, it, expect } from 'vitest';
import * as orchestratorApi from './index.ts';

describe('public API contract (index.ts)', () => {
  it('exports the stable top-level API surface', () => {
    expect(Object.keys(orchestratorApi).sort()).toEqual([
      'CONTROL_PROTOCOL_VERSION',
      'ControlClient',
      'ControlError',
      'assertAdapterContract',
      'createAdapter',
      'getMasterBootstrap',
      'getWorkerBootstrap',
      'validateAgents',
      'validateEventObject',
    ]);
  });

  it('exports callable API members', () => {
    expect(typeof orchestratorApi.ControlClient).toBe('function');
    expect(typeof orchestratorApi.ControlError).toBe('function');
    expect(orchestratorApi.CONTROL_PROTOCOL_VERSION).toBe(1);
    expect(typeof orchestratorApi.createAdapter).toBe('function');
    expect(typeof orchestratorApi.assertAdapterContract).toBe('function');
    expect(typeof orchestratorApi.getWorkerBootstrap).toBe('function');
    expect(typeof orchestratorApi.getMasterBootstrap).toBe('function');
    expect(typeof orchestratorApi.validateAgents).toBe('function');
    expect(typeof orchestratorApi.validateEventObject).toBe('function');
  });
});
