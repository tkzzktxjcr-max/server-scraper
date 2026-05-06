import { ImmowebScraper, toPropertyData as immowebToPropertyData } from "./immoweb.js";
import { ImmovlanScraper, toPropertyData as immovlanToPropertyData } from "./immovlan.js";
import { ZimmoScraper, toPropertyData as zimmoToPropertyData } from "./zimmo.js";
import { browserPool } from "../browser/manager.js";
import { saveProperty, updateJobStatus, createLog, PropertyData, getSiteBySlug } from "../appwrite/client.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { retryWithBackoff, randomDelay } from "../utils/retry.js";
import { validatePropertyData } from "../utils/validation.js";
import type { ScraperFilters } from "./base.js";
import type { Page } from "puppeteer-core";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export type ScraperSource = "immoweb" | "zimmo" | "immovlan";

export interface ScrapeParams {
  jobId: string;
  source: ScraperSource;
  filters?: ScraperFilters;
}

// ─────────────────────────────────────────────
// JOB LOGGER
// ─────────────────────────────────────────────

function createJobLogger(jobId: string) {
  return {
    info: (msg: string, meta?: Record<string, unknown>) => logger.info(msg, { jobId, ...meta }),
    warn: (msg: string, meta?: Record<string, unknown>) => logger.warn(msg, { jobId, ...meta }),
    error: (msg: string, meta?: Record<string, unknown>) => logger.error(msg, { jobId, ...meta }),
    debug: (msg: string, meta?: Record<string, unknown>) => logger.debug(msg, { jobId, ...meta }),
  };
}

// ─────────────────────────────────────────────
// MAIN SCRAPER RUNNER
// ─────────────────────────────────────────────

export async function runScraper(params: ScrapeParams): Promise<void> {
  const { jobId, source, filters } = params;
  const jobLogger = createJobLogger(jobId);

  let page: Page | null = null;

  try {
    jobLogger.info(`Starting scrape for ${source}`, filters);

    // Get site from Appwrite
    const site = await retryWithBackoff(
      () => getSiteBySlug(source),
      { context: `getSite-${source}`, maxRetries: 2 }
    );

    if (!site) throw new Error(`Site not found: ${source}`);

    // Update job status
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

    // Create the appropriate scraper
    const scraperFilters: ScraperFilters = {
      city: filters?.city,
      province: filters?.province,
      price_min: filters?.price_min,
      price_max: filters?.price_max,
      type: filters?.type,
      bedrooms_min: filters?.bedrooms_min,
    };

    let scraper;
    switch (source) {
      case "immoweb":
        scraper = new ImmowebScraper(site.$id, scraperFilters, jobLogger);
        break;
      case "immovlan":
        scraper = new ImmovlanScraper(site.$id, scraperFilters, jobLogger);
        break;
      case "zimmo":
        scraper = new ZimmoScraper(site.$id, scraperFilters, jobLogger);
        break;
      default:
        throw new Error(`Unknown source: ${source}`);
    }

    // Run the scrape
    const result = await scraper.scrape(page);

    // Log scrape stats
    jobLogger.info(`Scrape phase complete`, {
      totalFound: result.stats.totalFound,
      validated: result.stats.validated,
      skipped: result.stats.skipped,
      pagesScraped: result.stats.pagesScraped,
      missingFields: result.stats.missingFields,
    });

    // Save listings to Appwrite
    let newCount = 0;
    let updatedCount = 0;
    let failedCount = 0;

    for (const listing of result.listings) {
      try {
        // Convert to PropertyData
        let propertyData: PropertyData;
        switch (source) {
          case "immoweb":
            propertyData = immowebToPropertyData(listing as unknown as import("./immoweb.js").ImmowebListing, site.$id);
            break;
          case "immovlan":
            propertyData = immovlanToPropertyData(listing as unknown as import("./immovlan.js").ImmovlanListing, site.$id);
            break;
          case "zimmo":
            propertyData = zimmoToPropertyData(listing as unknown as import("./zimmo.js").ZimmoListing, site.$id);
            break;
          default:
            continue;
        }

        // Validate before saving
        const validation = validatePropertyData(propertyData);
        if (!validation.success) {
          jobLogger.warn(`Skipping invalid property ${listing.source_id}`, { errors: validation.errors });
          failedCount++;
          continue;
        }

        // Save with retry
        const res = await retryWithBackoff(
          () => saveProperty(propertyData),
          { context: `saveProperty-${listing.source_id}`, maxRetries: 2 }
        );

        if (res.isNew) newCount++;
        else updatedCount++;
      } catch (error) {
        jobLogger.error(`Failed to save property ${listing.source_id}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        failedCount++;
      }
    }

    // Log errors
    for (const error of result.errors) {
      await createLog({ jobId, siteId: site.$id, level: "ERROR", message: error });
    }

    // Update job status
    await updateJobStatus(jobId, "completed", {
      total_found: result.stats.totalFound,
      new_listings: newCount,
      updated: updatedCount,
      failed: failedCount,
    });

    await createLog({
      jobId,
      siteId: site.$id,
      level: "INFO",
      message: `Scrape completed: ${result.stats.totalFound} found, ${newCount} new, ${updatedCount} updated, ${failedCount} failed`,
      metadata: {
        pagesScraped: result.stats.pagesScraped,
        missingFields: result.stats.missingFields,
      },
    });

    jobLogger.info("Scrape completed successfully");
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    jobLogger.error(`Scrape failed: ${errorMessage}`);
    await updateJobStatus(jobId, "failed", undefined, errorMessage);

    try {
      const site = await getSiteBySlug(source);
      if (site) {
        await createLog({
          jobId,
          siteId: site.$id,
          level: "ERROR",
          message: `Scrape failed: ${errorMessage}`,
        });
      }
    } catch {
      // Can't even log — just skip
    }
  } finally {
    if (page) await browserPool.closePage(page);
  }
}