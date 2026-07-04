export interface Logger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export function createLogger(moduleName: string): Logger {
  const scope = String(moduleName || 'video-script').trim() || 'video-script';
  const write = (level: 'error' | 'warn' | 'info' | 'debug', message: string, args: unknown[]) => {
    if (process.env.ORKAS_VIDEO_SCRIPT_DEBUG !== '1') return;
    const line = `[${scope}] ${message}`;
    if (level === 'error') console.error(line, ...args);
    else if (level === 'warn') console.warn(line, ...args);
    else if (level === 'debug') console.debug(line, ...args);
    else console.info(line, ...args);
  };
  return {
    error: (message, ...args) => write('error', message, args),
    warn: (message, ...args) => write('warn', message, args),
    info: (message, ...args) => write('info', message, args),
    debug: (message, ...args) => write('debug', message, args),
  };
}
