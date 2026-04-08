const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 } as const;
type LogLevel = keyof typeof LEVELS;

function getThreshold(): number {
  const raw = process.env.ORC_LOG_LEVEL?.toLowerCase() as LogLevel | undefined;
  return (raw !== undefined && raw in LEVELS) ? LEVELS[raw] : LEVELS.warn;
}

export const logger = {
  debug: (...args: unknown[]) => { if (getThreshold() <= LEVELS.debug) console.debug(...args); },
  info:  (...args: unknown[]) => { if (getThreshold() <= LEVELS.info)  console.log(...args); },
  warn:  (...args: unknown[]) => { if (getThreshold() <= LEVELS.warn)  console.warn(...args); },
  error: (...args: unknown[]) => { if (getThreshold() <= LEVELS.error) console.error(...args); },
};
