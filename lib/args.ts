import { parseArgs } from 'node:util';

/**
 * Parse a --name=value flag from argv.
 * Handles values that contain '=' (e.g. --key=a=b).
 * Returns the value string, or null if the flag is absent.
 */
export function flag(name: string, argv: string[] = process.argv.slice(2)): string | null {
  const match = argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

/**
 * Parse --name=value and coerce to a positive integer.
 * Returns defaultVal if the flag is absent or the value is not a positive integer.
 */
export function intFlag(name: string, defaultVal: number, argv: string[] = process.argv.slice(2)): number {
  const raw = flag(name, argv);
  if (raw == null) return defaultVal;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultVal;
}

/**
 * Parse a boolean flag --name from argv.
 * Returns true if --name is present as a bare flag, or if --name=true is set.
 */
export function boolFlag(name: string, argv: string[] = process.argv.slice(2)): boolean {
  return argv.includes(`--${name}`) || flag(name, argv) === 'true';
}

/**
 * Collect all --name=value occurrences from argv.
 * Returns an array of value strings (empty array if the flag never appears).
 */
export function flagAll(name: string, argv: string[] = process.argv.slice(2)): string[] {
  return argv
    .filter((a) => a.startsWith(`--${name}=`))
    .map((a) => a.split('=').slice(1).join('='));
}

export type ParseOptions = Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean }>;

export interface ParsedCommand<O extends ParseOptions> {
  values: { [K in keyof O]?: O[K] extends { multiple: true } ? string[] : O[K]['type'] extends 'boolean' ? boolean : string };
  positionals: string[];
}

/**
 * Strict per-command argument parsing (node:util parseArgs): accepts `--x=v` and `--x v`,
 * rejects unknown flags, and never takes a flag's value as a positional.
 * Throws a usage error (message includes the usage line) so callers can print it and exit 1.
 */
export function parseCommandArgs<O extends ParseOptions>(
  usage: string,
  options: O,
  argv: string[] = process.argv.slice(2),
  maxPositionals = 0,
): ParsedCommand<O> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nUsage: ${usage}`);
  }
  if (parsed.positionals.length > maxPositionals) {
    throw new Error(`unexpected argument: ${parsed.positionals[maxPositionals]}\nUsage: ${usage}`);
  }
  return parsed as unknown as ParsedCommand<O>;
}

/** Like parseCommandArgs, but prints the usage error and exits 1. */
export function parseCommandArgsOrExit<O extends ParseOptions>(
  usage: string,
  options: O,
  argv: string[] = process.argv.slice(2),
  maxPositionals = 0,
): ParsedCommand<O> {
  try {
    return parseCommandArgs(usage, options, argv, maxPositionals);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
