/**
 * Minimal logging port. Library code depends on this interface only, so the
 * HTTP layer can later plug in its own logger (e.g. Fastify's pino) without
 * the portal adapter knowing about it.
 *
 * Contract: never pass secrets (passwords, cookies, signing secrets) in `context`.
 */
export type LogContext = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export const consoleLogger: Logger = {
  debug: (message, context) => console.debug(message, context ?? ""),
  info: (message, context) => console.info(message, context ?? ""),
  warn: (message, context) => console.warn(message, context ?? ""),
  error: (message, context) => console.error(message, context ?? ""),
};

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

/**
 * One JSON object per line on stdout: easy to read in `docker logs` and to
 * ship to any log system later. Lines below `minLevel` are dropped.
 */
export function createJsonLogger(minLevel: LogLevel = "info", base: LogContext = {}): Logger {
  const write = (level: LogLevel, message: string, context?: LogContext) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    process.stdout.write(
      `${JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...base, ...context })}\n`,
    );
  };
  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
  };
}
