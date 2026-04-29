export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createLogger(subsystem: string, level: LogLevel = "info"): Logger {
  const threshold = LOG_LEVELS[level];
  const prefix = `[${subsystem}]`;

  function shouldLog(lvl: LogLevel): boolean {
    return LOG_LEVELS[lvl] >= threshold;
  }

  return {
    debug(msg, ...args) {
      if (shouldLog("debug")) console.debug(prefix, msg, ...args);
    },
    info(msg, ...args) {
      if (shouldLog("info")) console.info(prefix, msg, ...args);
    },
    warn(msg, ...args) {
      if (shouldLog("warn")) console.warn(prefix, msg, ...args);
    },
    error(msg, ...args) {
      if (shouldLog("error")) console.error(prefix, msg, ...args);
    },
  };
}
