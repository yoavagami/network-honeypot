import pino from "pino";

export interface LoggerOptions {
  service: string;
  level?: string;
}

/**
 * Structured JSON logger. Every log line carries `service` and, when bound via
 * `.child({ requestId, actorId })`, correlation IDs — see docs/SECURITY.md / brief §22.
 */
export function createLogger({ service, level }: LoggerOptions) {
  return pino({
    level: level ?? process.env.LOG_LEVEL ?? "info",
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ["*.password", "*.headers.cookie", "*.headers.authorization", "req.headers.cookie"],
      censor: "[redacted]",
    },
  });
}

/**
 * Minimal structural logger interface — deliberately not `pino.Logger` itself, so both our own
 * pino instances and Fastify's own request-scoped logger (which is pino-compatible but a
 * distinct generic type) satisfy it without an unsafe cast at every call site.
 */
export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
}
