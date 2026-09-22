export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, details?: Readonly<Record<string, unknown>>): void;
  info(message: string, details?: Readonly<Record<string, unknown>>): void;
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}

const levels: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export function createLogger(minimumLevel: LogLevel): Logger {
  const minimumIndex = levels.indexOf(minimumLevel);
  const write = (
    level: LogLevel,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): void => {
    if (levels.indexOf(level) < minimumIndex) return;
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(details === undefined ? {} : { details }),
    });
    const stream = level === "error" ? process.stderr : process.stdout;
    stream.write(`${entry}\n`);
  };

  return Object.freeze({
    debug: (message: string, details?: Readonly<Record<string, unknown>>) =>
      write("debug", message, details),
    info: (message: string, details?: Readonly<Record<string, unknown>>) =>
      write("info", message, details),
    warn: (message: string, details?: Readonly<Record<string, unknown>>) =>
      write("warn", message, details),
    error: (message: string, details?: Readonly<Record<string, unknown>>) =>
      write("error", message, details),
  });
}
