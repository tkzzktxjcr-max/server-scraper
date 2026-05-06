import { Router, Request, Response } from "express";
import { checkRateLimit } from "../utils/rate-limit.js";
import { jobQueue } from "../jobs/queue.js";
import { createJob, getSiteBySlug, getJob, databases, APPWRITE_DATABASE_ID, COLLECTIONS } from "../appwrite/client.js";
import { logger } from "../utils/logger.js";

export const scrapeRouter = Router();

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

    const { source, trigger, filters } = req.body;

    if (!source || !trigger) {
      return res.status(400).json({
        error: "Missing required fields",
        message: "source and trigger are required",
      });
    }

    logger.info(`Scrape request received: ${source} (${trigger})`, { filters });

    // Get or create site
    let site = await getSiteBySlug(source);
    
    if (!site) {
      // Create the site if it doesn't exist
      logger.info(`Site ${source} not found, creating it...`);
      const { ID } = await import("appwrite");
      
      const siteData: Record<string, unknown> = {
        name: source.charAt(0).toUpperCase() + source.slice(1),
        slug: source,
        base_url: `https://www.${source}.be`,
        is_active: true,
        rate_limit_ms: 2000,
        properties_count: 0,
        last_scrape_at: null,
        last_scrape_status: null,
        created_at: new Date().toISOString(),
      };

      try {
        site = await databases.createDocument(
          APPWRITE_DATABASE_ID,
          COLLECTIONS.SCRAPING_SITES,
          ID.unique(),
          siteData
        );
        logger.info(`Created site: ${source}`);
      } catch (createError) {
        logger.error(`Failed to create site ${source}:`, { error: createError instanceof Error ? createError.message : String(createError) });
        return res.status(500).json({
          error: "Failed to create site",
          message: String(createError),
        });
      }
    }

    // Create job document in Appwrite
    const jobId = await createJob({
      siteId: site.$id,
      trigger: trigger || "manual",
      filters: filters || {},
      createdBy: trigger === "agent" ? "hermes-agent" : "admin",
    });

    // Add job to queue
    jobQueue.add({
      jobId,
      source: source,
      siteSlug: source,
      filters: filters || {},
      trigger: trigger || "manual",
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
    logger.error("Failed to create scrape job", { error: error instanceof Error ? error.message : String(error) });
    return res.status(500).json({
      error: "Failed to create scrape job",
      message: String(error),
    });
  }
});

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
    logger.error("Failed to get job status", { error: error instanceof Error ? error.message : String(error), jobId: req.params.id });
    return res.status(500).json({
      error: "Failed to get job status",
      message: String(error),
    });
  }
});

scrapeRouter.get("/queue", async (_req: Request, res: Response) => {
  const status = jobQueue.getStatus();
  return res.json({
    running: status.running,
    queued: status.queued,
    maxConcurrent: 3,
  });
});