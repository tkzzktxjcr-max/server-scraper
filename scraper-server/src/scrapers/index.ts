import { BaseScraper, ScraperFilters } from "./base.js";
import { ImmowebScraper } from "./immoweb.js";
import { ImmovlanScraper } from "./immovlan.js";
import { ZimmoScraper } from "./zimmo.js";
import { browserPool, handleCookieConsent } from "../browser/manager.js";
import { createJob, updateJobStatus, saveProperty, getSiteBySlug, PropertyData } from "../appwrite/client.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { randomDelay } from "../utils/retry.js";

export type ScraperSource = "immoweb" | "immovlan" | "zimmo";

export interface ScrapeParams {
  jobId: string;
  source: ScraperSource;
  filters?: ScraperFilters;
}

const SCRAPER_MAP: Record<ScraperSource, new (logger: any) => BaseScraper> = {
  immoweb: ImmowebScraper,
  immovlan: ImmovlanScraper,
  zimmo: ZimmoScraper,
};

export async function runScraper(params: ScrapeParams): Promise<void> {
  const { jobId, source, filters } = params;
  
  logger.info(`Starting scraper: ${source}`, { jobId, filters });

  const scraperClass = SCRAPER_MAP[source];
  if (!scraperClass) {
    throw new Error(`Unknown scraper source: ${source}`);
  }

  const jobLogger: any = {
    info: (msg: string, meta?: Record<string, unknown>) => logger.info(`[${jobId}] ${msg}`, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => logger.warn(`[${jobId}] ${msg}`, meta),
    error: (msg: string, meta?: Record<string, unknown>) => logger.error(`[${jobId}] ${msg}`, meta),
  };

  const scraper = new scraperClass(jobLogger);

  try {
    await createJob({
      siteId: jobId,
      trigger: "manual",
      filters: filters || {},
      createdBy: "scraper-server",
    });

    const page = await browserPool.createPage();
    
    try {
      await handleCookieConsent(page);
      
      const scraperFilters = {
        city: filters?.city,
        province: filters?.province,
        price_min: filters?.price_min,
        price_max: filters?.price_max,
        type: filters?.type,
        bedrooms_min: filters?.bedrooms_min,
      };

      const searchResult = await scraper.scrapeSearchPage(page, scraper.baseUrl);
      
      logger.info(`Found ${searchResult.totalFound} listings`, { jobId });

      let newCount = 0;
      let updatedCount = 0;
      let failedCount = 0;

      for (const listing of searchResult.listings.slice(0, config.scraper.maxPages)) {
        try {
          await randomDelay();
          
          const detailData = await scraper.scrapeDetailPage(page, listing.url);
          
          const propertyData: PropertyData = {
            site_id: jobId,
            source_id: listing.source_id,
            url: listing.url,
            title: detailData.title || listing.title || "",
            description: detailData.description || "",
            price: detailData.price || listing.price || 0,
            surface_sqm: detailData.surface_sqm || listing.surface_sqm || 0,
            bedrooms: detailData.bedrooms || listing.bedrooms || 0,
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
            year_built: detailData.year_built !== undefined ? detailData.year_built : null,
          };

          const result = await saveProperty(propertyData);
          
          if (result.isNew) {
            newCount++;
          } else {
            updatedCount++;
          }
        } catch (error) {
          failedCount++;
          logger.error(`Failed to process listing`, { 
            jobId, 
            url: listing.url, 
            error: error instanceof Error ? error.message : String(error) 
          });
        }
      }

      await updateJobStatus(jobId, "completed", {
        total_found: searchResult.totalFound,
        new_listings: newCount,
        updated: updatedCount,
        failed: failedCount,
      });

    } finally {
      await browserPool.closePage(page);
    }

  } catch (error) {
    logger.error(`Scraper failed`, { 
      jobId, 
      source, 
      error: error instanceof Error ? error.message : String(error) 
    });
    
    await updateJobStatus(jobId, "failed", undefined, error instanceof Error ? error.message : String(error));
  }
}