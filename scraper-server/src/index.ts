import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { scrapeRouter } from "./routes/scrape.js";
import { schedulesRouter } from "./routes/schedules.js";
import { browserPool } from "./browser/manager.js";
import { scheduler } from "./scheduler/scheduler.js";
import { jobQueue } from "./jobs/queue.js";

// ─────────────────────────────────────────────
// EXPRESS APP SETUP
// ─────────────────────────────────────────────

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`, { 
    ip: req.ip,
    userAgent: req.get("user-agent")
  });
  next();
});

// Rate limiting for all routes
const globalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  message: {
    error: "Too many requests",
    retryAfter: Math.ceil(config.rateLimit.windowMs / 1000),
  },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// Health check endpoint
app.get("/health", (_req, res) => {
  const queueStatus = jobQueue.getStatus();
  const schedulerStatus = scheduler.getStatus();
  
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "1.1.0",
    environment: config.server.nodeEnv,
    queue: queueStatus,
    scheduler: schedulerStatus,
    uptime: process.uptime(),
  });
});

// API routes
app.use("/api/scrape", scrapeRouter);
app.use("/api/schedules", schedulesRouter);

// ─────────────────────────────────────────────
// ERROR HANDLING
// ─────────────────────────────────────────────

// 404 handler
app.use((_req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: "The requested endpoint does not exist",
  });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error("Unhandled error", { error: err });
  res.status(500).json({
    error: "Internal Server Error",
    message: config.server.nodeEnv === "development" ? err.message : "An unexpected error occurred",
  });
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────

const server = app.listen(config.server.port, "0.0.0.0", async () => {
  logger.info(`🚀 Scraper server starting...`, {
    port: config.server.port,
    environment: config.server.nodeEnv,
    headless: config.browser.headless,
    maxConcurrent: config.rateLimit.maxConcurrentJobs,
  });

  // Initialize scheduler
  try {
    await scheduler.initialize();
    logger.info("✅ Scheduler initialized successfully");
  } catch (error) {
    logger.error("❌ Failed to initialize scheduler", { error });
    // Server will still start, but scheduled jobs won't run
  }
});

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────

const gracefulShutdown = async (signal: string) => {
  logger.info(`${signal} received, shutting down gracefully...`);
  
  // Stop accepting new connections
  server.close(() => {
    logger.info("HTTP server closed");
  });

  // Shutdown scheduler
  await scheduler.shutdown();
  
  // Cleanup browser pool
  await browserPool.cleanup();
  
  logger.info("Cleanup complete, exiting");
  process.exit(0);
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error });
  gracefulShutdown("uncaughtException");
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled rejection", { reason, promise });
});

export default app;