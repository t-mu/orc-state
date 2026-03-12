/**
 * Parse a --name=value flag from argv.
 * Handles values that contain '=' (e.g. --key=a=b).
 * Returns the value string, or null if the flag is absent.
 */
export function flag(name, argv = process.argv.slice(2)) {
  const match = argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

/**
 * Parse --name=value and coerce to a positive integer.
 * Returns defaultVal if the flag is absent or the value is not a positive integer.
 */
export function intFlag(name, defaultVal, argv = process.argv.slice(2)) {
  const raw = flag(name, argv);
  if (raw == null) return defaultVal;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultVal;
}

/**
 * Collect all --name=value occurrences from argv.
 * Returns an array of value strings (empty array if the flag never appears).
 */
export function flagAll(name, argv = process.argv.slice(2)) {
  return argv
    .filter((a) => a.startsWith(`--${name}=`))
    .map((a) => a.split('=').slice(1).join('='));
}
