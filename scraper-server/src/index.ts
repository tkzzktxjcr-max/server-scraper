import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { scrapeRouter } from "./routes/scrape.js";
import { schedulesRouter } from "./routes/schedules.js";
import { browserPool } from "./browser/playwright-manager.js";
import { scheduler } from "./scheduler/scheduler.js";
import { jobQueue } from "./jobs/queue.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`, { ip: req.ip, userAgent: req.get("user-agent") });
  next();
});

const globalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  message: { error: "Too many requests", retryAfter: Math.ceil(config.rateLimit.windowMs / 1000) },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

app.get("/health", (_req, res) => {
  const queueStatus = jobQueue.getStatus();
  const schedulerStatus = scheduler.getStatus();
  res.json({ status: "ok", timestamp: new Date().toISOString(), version: "2.0.0", environment: config.server.nodeEnv, queue: queueStatus, scheduler: schedulerStatus, uptime: process.uptime() });
});

app.use("/api/scrape", scrapeRouter);
app.use("/api/schedules", schedulesRouter);

app.use((_req, res) => res.status(404).json({ error: "Not Found", message: "The requested endpoint does not exist" }));
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error("Unhandled error", { error: err });
  res.status(500).json({ error: "Internal Server Error", message: config.server.nodeEnv === "development" ? err.message : "An unexpected error occurred" });
});

const server = app.listen(config.server.port, "0.0.0.0", async () => {
  logger.info(`🚀 Scraper server starting...`, { port: config.server.port, environment: config.server.nodeEnv });
  try {
    await scheduler.initialize();
    logger.info("✅ Scheduler initialized");
  } catch (error) {
    logger.error("❌ Failed to initialize scheduler", { error });
  }
});

const gracefulShutdown = async (signal: string) => {
  logger.info(`${signal} received, shutting down gracefully...`);
  server.close(() => logger.info("HTTP server closed"));
  await scheduler.shutdown();
  await browserPool.cleanup();
  logger.info("Cleanup complete, exiting");
  process.exit(0);
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("uncaughtException", (error) => { logger.error("Uncaught exception", { error }); gracefulShutdown("uncaughtException"); });
process.on("unhandledRejection", (reason, promise) => { logger.error("Unhandled rejection", { reason, promise }); });

export default app;