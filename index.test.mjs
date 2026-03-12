import { describe, it, expect } from 'vitest';
import * as orchestratorApi from './index.mjs';

describe('public API contract (index.mjs)', () => {
  it('exports the stable top-level API surface', () => {
    expect(Object.keys(orchestratorApi).sort()).toEqual([
      'assertAdapterContract',
      'createAdapter',
      'validateAgents',
      'validateBacklog',
      'validateClaims',
      'validateEventObject',
      'validateStateDir',
    ]);
  });

  it('exports callable API members', () => {
    expect(typeof orchestratorApi.createAdapter).toBe('function');
    expect(typeof orchestratorApi.assertAdapterContract).toBe('function');
    expect(typeof orchestratorApi.validateBacklog).toBe('function');
    expect(typeof orchestratorApi.validateAgents).toBe('function');
    expect(typeof orchestratorApi.validateClaims).toBe('function');
    expect(typeof orchestratorApi.validateStateDir).toBe('function');
    expect(typeof orchestratorApi.validateEventObject).toBe('function');
  });
});
