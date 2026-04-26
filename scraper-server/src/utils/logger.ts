// @ts-nocheck
import winston from "winston";

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.colorize(),
  winston.format.printf((info) => {
    const { timestamp, level, message, ...meta } = info;
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
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