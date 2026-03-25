export function stripAnsi(value: unknown): string {
  return String(value).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}
