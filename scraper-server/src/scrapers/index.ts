import { Page } from "puppeteer";
import { scrapeImmoweb, toPropertyData as immowebToPropertyData } from "./immoweb.js";
import { scrapeZimmo, toPropertyData as zimmoToPropertyData } from "./zimmo.js";
import { scrapeImmovlan, toPropertyData as immovlanToPropertyData } from "./immovlan.js";
import { browserPool } from "../browser/manager.js";
import { 
  saveProperty, 
  updateJobStatus, 
  createLog, 
  PropertyData,
  getSiteBySlug 
} from "../appwrite/client.js";
import { logger, JobLogger } from "../utils/logger.js";

// ─────────────────────────────────────────────
// TYPE DEFINITIONS
// ─────────────────────────────────────────────

export type ScraperSource = "immoweb" | "zimmo" | "immovlan";

export interface ScrapeParams {
  jobId: string;
  source: ScraperSource;
  filters?: {
    city?: string;
    price_min?: number;
    price_max?: number;
    type?: string;
  };
}

export interface ScrapeResult {
  listings: unknown[];
  errors: string[];
}

// ─────────────────────────────────────────────
// SCRAPER RUNNER
// ─────────────────────────────────────────────

export async function runScraper(params: ScrapeParams): Promise<void> {
  const { jobId, source, filters } = params;
  const jobLogger: JobLogger = {
    info: (message: string, meta?: Record<string, unknown>) => 
      logger.info(message, { jobId, ...meta }),
    warn: (message: string, meta?: Record<string, unknown>) => 
      logger.warn(message, { jobId, ...meta }),
    error: (message: string, meta?: Record<string, unknown>) => 
      logger.error(message, { jobId, ...meta }),
    debug: (message: string, meta?: Record<string, unknown>) => 
      logger.debug(message, { jobId, ...meta }),
  };
  
  let page: Page | null = null;

  try {
    jobLogger.info(`Starting scrape for ${source}`, { filters });

    // Get site info from Appwrite
    const site = await getSiteBySlug(source);
    if (!site) {
      throw new Error(`Site not found: ${source}`);
    }

    // Update job status to running
    await updateJobStatus(jobId, "running");
    await createLog({
      jobId,
      siteId: site.$id,
      level: "INFO",
      message: `Starting scrape for ${source}`,
      metadata: { filters },
    });

    // Create browser page
    page = await browserPool.createPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Scrape based on source
    let scrapeResult: ScrapeResult;
    switch (source) {
      case "immoweb":
        scrapeResult = await scrapeImmoweb(page, filters || {}, jobLogger);
        break;
      case "zimmo":
        scrapeResult = await scrapeZimmo(page, filters || {}, jobLogger);
        break;
      case "immovlan":
        scrapeResult = await scrapeImmovlan(page, filters || {}, jobLogger);
        break;
      default:
        throw new Error(`Unknown source: ${source}`);
    }

    // Process results
    let newCount = 0;
    let updatedCount = 0;
    let failedCount = 0;

    for (const listing of scrapeResult.listings) {
      try {
        let propertyData: PropertyData;
        
        switch (source) {
          case "immoweb":
            propertyData = immowebToPropertyData(listing as Parameters<typeof immowebToPropertyData>[0], site.$id);
            break;
          case "zimmo":
            propertyData = zimmoToPropertyData(listing as Parameters<typeof zimmoToPropertyData>[0], site.$id);
            break;
          case "immovlan":
            propertyData = immovlanToPropertyData(listing as Parameters<typeof immovlanToPropertyData>[0], site.$id);
            break;
        }

        const result = await saveProperty(propertyData);
        if (result.isNew) {
          newCount++;
        } else {
          updatedCount++;
        }
      } catch (error) {
        failedCount++;
        jobLogger.error(`Failed to save property: ${error}`);
      }
    }

    // Log errors
    for (const error of scrapeResult.errors) {
      await createLog({
        jobId,
        siteId: site.$id,
        level: "ERROR",
        message: error,
      });
    }

    // Update job with stats
    await updateJobStatus(jobId, "completed", {
      total_found: scrapeResult.listings.length,
      new_listings: newCount,
      updated: updatedCount,
      failed: failedCount,
    });

    await createLog({
      jobId,
      siteId: site.$id,
      level: "INFO",
      message: `Scrape completed: ${scrapeResult.listings.length} found, ${newCount} new, ${updatedCount} updated, ${failedCount} failed`,
    });

    jobLogger.info(`Scrape completed successfully`, {
      total: scrapeResult.listings.length,
      new: newCount,
      updated: updatedCount,
      failed: failedCount,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    jobLogger.error(`Scrape failed: ${errorMessage}`);

    await updateJobStatus(jobId, "failed", undefined, errorMessage);

    // Get site info for logging
    const site = await getSiteBySlug(source);
    if (site) {
      await createLog({
        jobId,
        siteId: site.$id,
        level: "ERROR",
        message: `Scrape failed: ${errorMessage}`,
      });
    }
  } finally {
    if (page) {
      await browserPool.closePage(page);
    }
  }
}