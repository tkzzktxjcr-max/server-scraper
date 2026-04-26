import winston from "winston";

// ─────────────────────────────────────────────
// LOGGER CONFIGURATION
// ─────────────────────────────────────────────

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length > 0 
      ? ` ${JSON.stringify(meta)}` 
      : "";
    return `[${timestamp}] ${level}: ${message}${metaStr}`;
  })
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: logFormat,
  defaultMeta: { service: "scraper-server" },
  transports: [
    new winston.transports.Console({
      format: process.env.NODE_ENV === "production" ? logFormat : consoleFormat,
    }),
  ],
});

// ─────────────────────────────────────────────
// JOB-SPECIFIC LOGGER INTERFACE
// ─────────────────────────────────────────────

export interface JobLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
}

// ─────────────────────────────────────────────
// JOB-SPECIFIC LOGGER
// ─────────────────────────────────────────────

export function createJobLogger(jobId: string): JobLogger {
  return {
    info: (message: string, meta?: Record<string, unknown>) => 
      logger.info(message, { jobId, ...meta }),
    warn: (message: string, meta?: Record<string, unknown>) => 
      logger.warn(message, { jobId, ...meta }),
    error: (message: string, meta?: Record<string, unknown>) => 
      logger.error(message, { jobId, ...meta }),
    debug: (message: string, meta?: Record<string, unknown>) => 
      logger.debug(message, { jobId, ...meta }),
  };
}