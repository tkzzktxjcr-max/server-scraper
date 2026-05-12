/**
 * HTTP scraper dispatcher — runs HTTP-only scrapers without Playwright.
 * Used by the job queue when the source has an HTTP scraper available.
 */
import { EraHttpScraper } from "./era-http.js";
import { ImmovlanHttpScraper } from "./immovlan-http.js";
import { ImmotopScraper } from "./immotop.js";
import { ScraperFilters, JobLogger, SearchResultItem } from "./base.js";
import { updateJobStatus, saveProperty, getSiteBySlug } from "../appwrite/client.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";

export type HttpScraperSource = "era" | "immovlan" | "immotop";

const HTTP_SCRAPER_SOURCES: Set<string> = new Set(["era", "immovlan", "immotop"]);

export function isHttpScraperSource(source: string): boolean {
  return HTTP_SCRAPER_SOURCES.has(source);
}

function createJobLogger(jobId: string): JobLogger {
  return {
    info: (msg: string, meta?: Record<string, unknown>) => logger.info(`[${jobId}] ${msg}`, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => logger.warn(`[${jobId}] ${msg}`, meta),
    error: (msg: string, meta?: Record<string, unknown>) => logger.error(`[${jobId}] ${msg}`, meta),
  };
}

export async function runHttpScraper(params: {
  jobId: string;
  source: HttpScraperSource;
  filters?: ScraperFilters;
}): Promise<void> {
  const { jobId, source, filters } = params;
  const jobLogger = createJobLogger(jobId);

  logger.info(`Starting HTTP scraper: ${source}`, { jobId, filters });

  try {
    await updateJobStatus(jobId, "running");

    const siteDoc = await getSiteBySlug(source);
    if (!siteDoc) {
      throw new Error(`Site "${source}" not found in Appwrite. Create it in scraping_sites collection first.`);
    }
    const siteId = siteDoc.$id;
    jobLogger.info(`Resolved site ID: ${siteId}`);

    let listings: SearchResultItem[] = [];
    let detailScraper: any;

    // ── Dispatch to the right HTTP scraper ──
    if (source === "era") {
      const scraper = new EraHttpScraper(jobLogger);
      const result = await scraper.run(filters);
      listings = result.listings;
      detailScraper = scraper;
    } else if (source === "immovlan") {
      const scraper = new ImmovlanHttpScraper(jobLogger);
      const result = await scraper.run(filters);
      listings = result.listings;
      detailScraper = scraper;
    } else if (source === "immotop") {
      const scraper = new ImmotopScraper(jobLogger);
      const url = scraper.buildSearchUrl(filters);
      listings = await scraper.extractListings(url);
      detailScraper = scraper;
    } else {
      throw new Error(`Unknown HTTP scraper source: ${source}`);
    }

    jobLogger.info(`Found ${listings.length} listings`);

    let newCount = 0, updatedCount = 0, failedCount = 0;
    const maxListings = Math.min(listings.length, config.scraper.maxPages);

    for (let i = 0; i < maxListings; i++) {
      const listing = listings[i];
      try {
        // Delay between requests
        const delay = config.rateLimit.delayMs + Math.random() * config.rateLimit.jitterMs;
        await new Promise((r) => setTimeout(r, delay));

        jobLogger.info(`Processing ${i + 1}/${maxListings}: ${listing.url}`);

        // Fetch detail + save
        const detailData = await detailScraper.scrapeDetailPage(listing.url);

        const propertyData = {
          site_id: siteId,
          source_id: listing.source_id,
          url: listing.url,
          title: detailData.title || listing.title || "",
          description: detailData.description || "",
          price: detailData.price || listing.price || 0,
          surface_sqm: detailData.surface_sqm || 0,
          bedrooms: detailData.bedrooms || 0,
          bathrooms: detailData.bathrooms || 0,
          type: detailData.type || listing.type || "house",
          city: detailData.city || listing.city || "",
          postal_code: detailData.postal_code || "",
          province: detailData.province || "",
          latitude: detailData.latitude || 0,
          longitude: detailData.longitude || 0,
          address: detailData.address || "",
          photos: detailData.photos || [],
          agent_name: detailData.agent_name || "",
          agent_phone: detailData.agent_phone || "",
          agent_agency: detailData.agent_agency || "",
          amenities: [],
          energy_rating: detailData.energy_rating || "",
          year_built: detailData.year_bunt || null,
        };

        const result = await saveProperty(propertyData);
        if (result.isNew) newCount++;
        else updatedCount++;
      } catch (error) {
        failedCount++;
        jobLogger.error(`Failed to process listing`, {
          url: listing.url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await updateJobStatus(jobId, "completed", {
      total_found: listings.length,
      new_listings: newCount,
      updated: updatedCount,
      failed: failedCount,
    });

    jobLogger.info(`Completed: ${newCount} new, ${updatedCount} updated, ${failedCount} failed`);
  } catch (error) {
    jobLogger.error(`HTTP scraper failed`, { error: error instanceof Error ? error.message : String(error) });
    await updateJobStatus(jobId, "failed", undefined, error instanceof Error ? error.message : String(error));
  }
}