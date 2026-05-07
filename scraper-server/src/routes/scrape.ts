import { Router, Request, Response } from "express";
import { checkRateLimit } from "../utils/rate-limit.js";
import { jobQueue } from "../jobs/queue.js";
import { createJob, getSiteBySlug, getJob, databases, APPWRITE_DATABASE_ID, COLLECTIONS } from "../appwrite/client.js";
import { logger } from "../utils/logger.js";
import { runTestScrape } from "../scrapers/index.js";

export const scrapeRouter = Router();

scrapeRouter.post("/", async (req: Request, res: Response) => {
  try {
    const clientId = req.ip || "unknown";
    const rateLimitResult = checkRateLimit(clientId);
    if (!rateLimitResult.allowed) {
      return res.status(429).json({ error: "Rate limit exceeded", retryAfter: Math.ceil(rateLimitResult.resetIn / 1000) });
    }

    const { source, trigger, filters } = req.body;
    if (!source || !trigger) {
      return res.status(400).json({ error: "Missing required fields", message: "source and trigger are required" });
    }

    let site = await getSiteBySlug(source);
    if (!site) {
      const { ID } = await import("appwrite");
      const siteData = {
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
      site = await databases.createDocument(APPWRITE_DATABASE_ID, COLLECTIONS.SCRAPING_SITES, ID.unique(), siteData);
    }

    const jobId = await createJob({ siteId: site.$id, trigger: trigger || "manual", filters: filters || {}, createdBy: trigger === "agent" ? "hermes-agent" : "admin" });
    jobQueue.add({ jobId, source, siteSlug: source, filters: filters || {}, trigger: trigger || "manual" });

    return res.status(202).json({ jobId, status: "queued", message: "Scrape job queued", rateLimit: { remaining: rateLimitResult.remaining, resetIn: rateLimitResult.resetIn } });
  } catch (error) {
    return res.status(500).json({ error: "Failed to create scrape job", message: String(error) });
  }
});

scrapeRouter.post("/test", async (req: Request, res: Response) => {
  try {
    const { source, filters } = req.body;
    if (!source) return res.status(400).json({ error: "source is required" });

    const result = await runTestScrape(source, filters);
    
    return res.json({
      success: !result.error && result.listingsFound > 0,
      ...result,
      diagnostic: result.listingsFound === 0 ? {
        tip: "0 listings found. Check screenshotPath on server to see what the bot sees. The site may block headless browsers.",
        screenshot: result.screenshotPath || "No screenshot available",
      } : undefined,
    });
  } catch (error) {
    return res.status(500).json({ error: "Test scrape failed", message: error instanceof Error ? error.message : String(error) });
  }
});

scrapeRouter.get("/status/:id", async (req: Request, res: Response) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    return res.json({
      jobId: job.$id, status: job.status, trigger: job.trigger, filters: job.filters,
      stats: job.stats, started_at: job.started_at, completed_at: job.completed_at,
      error_message: job.error_message, created_by: job.created_by,
      queueStatus: { isQueued: jobQueue.isJobQueued(req.params.id), isRunning: jobQueue.isJobRunning(req.params.id) },
    });
  } catch (error) {
    return res.status(500).json({ error: "Failed to get job status", message: String(error) });
  }
});

scrapeRouter.get("/queue", async (_req: Request, res: Response) => {
  const status = jobQueue.getStatus();
  return res.json({ running: status.running, queued: status.queued, maxConcurrent: 3 });
});