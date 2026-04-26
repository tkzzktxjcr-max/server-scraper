import { Router, Request, Response } from "express";
import { z } from "zod";
import { checkRateLimit } from "../utils/rate-limit.js";
import { jobQueue } from "../jobs/queue.js";
import { createJob, getSiteBySlug, getJob } from "../appwrite/client.js";
import { logger } from "../utils/logger.js";
import type { ScraperSource } from "../scrapers/index.js";

export const scrapeRouter = Router();

// ─────────────────────────────────────────────
// VALIDATION SCHEMA
// ─────────────────────────────────────────────

const ScrapeSchema = z.object({
  source: z.enum(["immoweb", "zimmo", "immovlan"]),
  trigger: z.enum(["manual", "agent"]),
  filters: z
    .object({
      city: z.string().optional(),
      price_min: z.number().optional(),
      price_max: z.number().optional(),
      type: z.string().optional(),
    })
    .optional(),
});

// ─────────────────────────────────────────────
// POST /api/scrape - Trigger a new scrape job
// ─────────────────────────────────────────────

scrapeRouter.post("/", async (req: Request, res: Response) => {
  try {
    // Rate limiting
    const clientId = req.ip || "unknown";
    const rateLimitResult = checkRateLimit(clientId);

    if (!rateLimitResult.allowed) {
      return res.status(429).json({
        error: "Rate limit exceeded",
        retryAfter: Math.ceil(rateLimitResult.resetIn / 1000),
      });
    }

    // Validate request body
    const parseResult = ScrapeSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: "Invalid request",
        details: parseResult.error.issues,
      });
    }

    const { source, trigger, filters } = parseResult.data;

    logger.info(`Scrape request received: ${source} (${trigger})`, { filters });

    // Verify site exists
    const site = await getSiteBySlug(source);
    if (!site) {
      return res.status(404).json({
        error: `Site not found: ${source}`,
        message: `Make sure the site slug matches exactly. Available: immoweb, zimmo, immovlan`,
      });
    }

    // Create job document in Appwrite
    const jobId = await createJob({
      siteId: site.$id,
      trigger,
      filters,
      createdBy: trigger === "agent" ? "hermes-agent" : "admin",
    });

    // Add job to queue
    jobQueue.add({
      jobId,
      source: source as ScraperSource,
      filters,
      trigger,
    });

    logger.info(`Scrape job created and queued: ${jobId}`);

    return res.status(202).json({
      jobId,
      status: "queued",
      message: "Scrape job has been queued and will start shortly",
      rateLimit: {
        remaining: rateLimitResult.remaining,
        resetIn: rateLimitResult.resetIn,
      },
    });
  } catch (error) {
    logger.error("Failed to create scrape job", { error });
    return res.status(500).json({
      error: "Failed to create scrape job",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ─────────────────────────────────────────────
// GET /api/scrape/status/:id - Get job status
// ─────────────────────────────────────────────

scrapeRouter.get("/status/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        error: "Job ID is required",
      });
    }

    const job = await getJob(id);

    if (!job) {
      return res.status(404).json({
        error: "Job not found",
        jobId: id,
      });
    }

    // Check if job is queued
    const isQueued = jobQueue.isJobQueued(id);
    const isRunning = jobQueue.isJobRunning(id);

    return res.json({
      jobId: job.$id,
      status: job.status,
      trigger: job.trigger,
      filters: job.filters,
      stats: job.stats,
      started_at: job.started_at,
      completed_at: job.completed_at,
      error_message: job.error_message,
      created_by: job.created_by,
      queueStatus: {
        isQueued,
        isRunning,
      },
    });
  } catch (error) {
    logger.error("Failed to get job status", { error, jobId: req.params.id });
    return res.status(500).json({
      error: "Failed to get job status",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ─────────────────────────────────────────────
// GET /api/scrape/queue - Get queue status
// ─────────────────────────────────────────────

scrapeRouter.get("/queue", async (_req: Request, res: Response) => {
  const status = jobQueue.getStatus();

  return res.json({
    running: status.running,
    queued: status.queued,
    maxConcurrent: 3,
  });
});