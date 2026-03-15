export interface AjvError {
  instancePath?: string;
  dataPath?: string;
  message?: string;
}

/**
 * Format AJV validation errors into human-readable strings.
 * When prefix is provided, each error is prefixed with "<prefix>: ".
 */
export function formatAjvErrors(errors: AjvError[] | null | undefined, prefix?: string): string[] {
  return (errors ?? []).map((err) => {
    const pathRaw = err.instancePath ?? err.dataPath ?? '';
    const path = pathRaw && pathRaw.length > 0 ? pathRaw : '(root)';
    const msg = `${path} ${err.message}`;
    return prefix ? `${prefix}: ${msg}` : msg;
  });
}
