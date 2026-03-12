import Ajv from 'ajv';

/**
 * Build Ajv with shared orchestrator defaults and explicit date-time format
 * support so schema compilation does not emit unknown-format warnings.
 */
export function createOrchestratorAjv() {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    coerceTypes: true,
  });

  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value) => {
      if (typeof value !== 'string' || value.length === 0) return false;
      return Number.isFinite(new Date(value).getTime());
    },
  });

  return ajv;
}
