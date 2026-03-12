import { describe, expect, it } from 'vitest';
import { createOrchestratorAjv } from './ajvFactory.ts';

describe('createOrchestratorAjv', () => {
  it('supports date-time format validation', () => {
    const ajv = createOrchestratorAjv();
    const validate = ajv.compile({
      type: 'object',
      properties: {
        ts: { type: 'string', format: 'date-time' },
      },
      required: ['ts'],
      additionalProperties: false,
    });

    expect(validate({ ts: '2026-03-05T00:00:00Z' })).toBe(true);
    expect(validate({ ts: 'not-a-date' })).toBe(false);
  });
});
