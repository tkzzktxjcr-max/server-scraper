import { Router, Request, Response } from "express";
import { checkRateLimit } from "../utils/rate-limit.js";
import { jobQueue } from "../jobs/queue.js";
import { createJob, getSiteBySlug, getJob, databases, APPWRITE_DATABASE_ID, COLLECTIONS } from "../appwrite/client.js";
import { logger } from "../utils/logger.js";
import { runTestScrape } from "../scrapers/index.js";
import { isHttpScraperSource, runHttpScraper, HttpScraperSource } from "../scrapers/http-dispatcher.js";
import { EraHttpScraper } from "../scrapers/era-http.js";
import { ImmovlanHttpScraper } from "../scrapers/immovlan-http.js";
import { ImmotopScraper } from "../scrapers/immotop.js";

export const scrapeRouter = Router();

/**
 * POST /api/scrape — Queue a scrape job (HTTP or Playwright)
 */
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

    // Auto-create site in Appwrite if missing
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

    const jobId = await createJob({ siteId: site.$id, trigger, filters: filters || {}, createdBy: trigger === "agent" ? "hermes-agent" : "admin" });
    jobQueue.add({ jobId, source, siteSlug: source, filters: filters || {}, trigger });

    const mode = isHttpScraperSource(source) ? "http" : "playwright";
    return res.status(202).json({
      jobId,
      status: "queued",
      mode,
      message: `Scrape job queued (${mode} mode)`,
      rateLimit: { remaining: rateLimitResult.remaining, resetIn: rateLimitResult.resetIn },
    });
  } catch (error) {
    return res.status(500).json({ error: "Failed to create scrape job", message: String(error) });
  }
});

/**
 * POST /api/scrape/test — Quick test scrape (HTTP-only sources use direct HTTP, others use Playwright)
 */
scrapeRouter.post("/test", async (req: Request, res: Response) => {
  try {
    const { source, filters } = req.body;
    if (!source) return res.status(400).json({ error: "source is required" });

    // ── HTTP sources: test without Playwright ──
    if (isHttpScraperSource(source)) {
      const testLogger = {
        info: (msg: string) => logger.info(`[TEST-HTTP] ${msg}`),
        warn: (msg: string) => logger.warn(`[TEST-HTTP] ${msg}`),
        error: (msg: string) => logger.error(`[TEST-HTTP] ${msg}`),
      };

      let searchUrl = "";
      let listingsFound = 0;
      let sampleListings: any[] = [];
      let detailSample: Record<string, unknown> | null = null;

      if (source === "era") {
        const scraper = new EraHttpScraper(testLogger);
        const result = await scraper.run(filters);
        searchUrl = "https://www.era.be/nl/te-koop (sitemap-based)";
        listingsFound = result.totalFound;
        sampleListings = result.listings.slice(0, 3).map((l) => ({
          source_id: l.source_id, title: l.title, price: l.price, city: l.city, url: l.url,
        }));
        if (result.listings[0]) {
          detailSample = await scraper.scrapeDetailPage(result.listings[0].url);
        }
      } else if (source === "immovlan") {
        const scraper = new ImmovlanHttpScraper(testLogger);
        const result = await scraper.run(filters);
        searchUrl = "https://immovlan.be/sitemaps (sitemap-based)";
        listingsFound = result.totalFound;
        sampleListings = result.listings.slice(0, 3).map((l) => ({
          source_id: l.source_id, title: l.title, price: l.price, city: l.city, url: l.url,
        }));
        if (result.listings[0]) {
          detailSample = await scraper.scrapeDetailPage(result.listings[0].url);
        }
      } else if (source === "immotop") {
        const scraper = new ImmotopScraper(testLogger);
        searchUrl = scraper.buildSearchUrl(filters);
        const listings = await scraper.extractListings(searchUrl);
        listingsFound = listings.length;
        sampleListings = listings.slice(0, 3).map((l) => ({
          source_id: l.source_id, title: l.title, price: l.price, city: l.city, url: l.url,
        }));
        if (listings[0]) {
          detailSample = await scraper.scrapeDetailPage(listings[0].url);
        }
      }

      return res.json({
        success: listingsFound > 0,
        searchUrl,
        listingsFound,
        sampleListings,
        detailSample,
        mode: "http",
      });
    }

    // ── Playwright sources: original test ──
    const result = await runTestScrape(source, filters);
    return res.json({
      success: !result.error && result.listingsFound > 0,
      ...result,
      mode: "playwright",
      diagnostic: result.listingsFound === 0 ? {
        tip: "0 listings found. The site may block headless browsers. Try an HTTP source instead (era, immovlan, immotop).",
      } : undefined,
    });
  } catch (error) {
    return res.status(500).json({ error: "Test scrape failed", message: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * GET /api/scrape/status/:id — Get job status
 */
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

/**
 * GET /api/scrape/queue — Get queue status
 */
scrapeRouter.get("/queue", async (_req: Request, res: Response) => {
  const status = jobQueue.getStatus();
  return res.json({ running: status.running, queued: status.queued, maxConcurrent: 3 });
});

/**
 * GET /api/scrape/sources — List available sources and their mode
 */
scrapeRouter.get("/sources", async (_req: Request, res: Response) => {
  const httpSources = ["era", "immovlan", "immotop"];
  const playwrightSources = ["immoweb", "immovlan", "zimmo"];

  return res.json({
    http: httpSources.map((s) => ({ source: s, mode: "http", cloudReady: true })),
    playwright: playwrightSources.map((s) => ({ source: s, mode: "playwright", cloudReady: false, note: "May be blocked by cloudflare without proxy" })),
  });
});