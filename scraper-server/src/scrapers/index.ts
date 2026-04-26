// @ts-nocheck
import { Page } from "puppeteer";
import { scrapeImmoweb, toPropertyData as immowebToPropertyData } from "./immoweb.js";
import { scrapeZimmo, toPropertyData as zimmoToPropertyData } from "./zimmo.js";
import { scrapeImmovlan, toPropertyData as immovlanToPropertyData } from "./immovlan.js";
import { browserPool } from "../browser/manager.js";
import { saveProperty, updateJobStatus, createLog, PropertyData, getSiteBySlug } from "../appwrite/client.js";
import { logger } from "../utils/logger.js";

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

export async function runScraper(params: ScrapeParams): Promise<void> {
  const { jobId, source, filters } = params;
  
  const jobLogger = {
    info: (msg: string, meta?: any) => logger.info(msg, { jobId, ...meta }),
    warn: (msg: string, meta?: any) => logger.warn(msg, { jobId, ...meta }),
    error: (msg: string, meta?: any) => logger.error(msg, { jobId, ...meta }),
    debug: (msg: string, meta?: any) => logger.debug(msg, { jobId, ...meta }),
  };
  
  let page: Page | null = null;

  try {
    jobLogger.info(`Starting scrape for ${source}`, filters);

    const site = await getSiteBySlug(source);
    if (!site) throw new Error(`Site not found: ${source}`);

    await updateJobStatus(jobId, "running");
    await createLog({
      jobId,
      siteId: site.$id,
      level: "INFO",
      message: `Starting scrape for ${source}`,
      metadata: { filters },
    });

    page = await browserPool.createPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");

    let result;
    switch (source) {
      case "immoweb": result = await scrapeImmoweb(page, filters || {}, jobLogger); break;
      case "zimmo": result = await scrapeZimmo(page, filters || {}, jobLogger); break;
      case "immovlan": result = await scrapeImmovlan(page, filters || {}, jobLogger); break;
      default: throw new Error(`Unknown source: ${source}`);
    }

    let newCount = 0, updatedCount = 0, failedCount = 0;

    for (const listing of result.listings) {
      try {
        let propertyData: PropertyData;
        switch (source) {
          case "immoweb": propertyData = immowebToPropertyData(listing, site.$id); break;
          case "zimmo": propertyData = zimmoToPropertyData(listing, site.$id); break;
          case "immovlan": propertyData = immovlanToPropertyData(listing, site.$id); break;
        }
        const res = await saveProperty(propertyData);
        if (res.isNew) newCount++; else updatedCount++;
      } catch { failedCount++; }
    }

    for (const error of result.errors) {
      await createLog({ jobId, siteId: site.$id, level: "ERROR", message: error });
    }

    await updateJobStatus(jobId, "completed", {
      total_found: result.listings.length,
      new_listings: newCount,
      updated: updatedCount,
      failed: failedCount,
    });

    await createLog({
      jobId, siteId: site.$id, level: "INFO",
      message: `Scrape completed: ${result.listings.length} found, ${newCount} new, ${updatedCount} updated, ${failedCount} failed`,
    });

    jobLogger.info(`Scrape completed successfully`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    jobLogger.error(`Scrape failed: ${errorMessage}`);
    await updateJobStatus(jobId, "failed", undefined, errorMessage);
    const site = await getSiteBySlug(source);
    if (site) await createLog({ jobId, siteId: site.$id, level: "ERROR", message: `Scrape failed: ${errorMessage}` });
  } finally {
    if (page) await browserPool.closePage(page);
  }
}