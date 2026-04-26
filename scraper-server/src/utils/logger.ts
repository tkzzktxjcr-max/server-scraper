import winston from "winston";

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "scraper-server" },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length > 1 
            ? ` ${JSON.stringify(meta)}` 
            : "";
          return `[${timestamp}] ${level}: ${message}${metaStr}`;
        })
      ),
    }),
  ],
});

export function createJobLogger(jobId: string) {
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
