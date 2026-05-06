import { BaseScraper, ScraperFilters } from "./base.js";
import { ImmowebScraper } from "./immoweb.js";
import { ImmovlanScraper } from "./immovlan.js";
import { ZimmoScraper } from "./zimmo.js";
import { browserPool, handleCookieConsent } from "../browser/manager.js";
import { updateJobStatus, saveProperty, getSiteBySlug, PropertyData } from "../appwrite/client.js";
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

  const jobLogger = {
    info: (msg: string, meta?: Record<string, unknown>) => logger.info(`[${jobId}] ${msg}`, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => logger.warn(`[${jobId}] ${msg}`, meta),
    error: (msg: string, meta?: Record<string, unknown>) => logger.error(`[${jobId}] ${msg}`, meta),
  };

  const scraper = new scraperClass(jobLogger);

  try {
    // Update existing job to running
    await updateJobStatus(jobId, "running");

    const page = await browserPool.createPage();
    
    try {
      await handleCookieConsent(page);
      
      const searchUrl = scraper.buildSearchUrl(filters);
      jobLogger.info(`Search URL: ${searchUrl}`);
      
      const searchResult = await scraper.scrapeSearchPage(page, searchUrl);
      
      jobLogger.info(`Found ${searchResult.totalFound} listings from search page`);

      let newCount = 0;
      let updatedCount = 0;
      let failedCount = 0;
      const maxListings = Math.min(searchResult.listings.length, config.scraper.maxPages);

      for (let i = 0; i < maxListings; i++) {
        const listing = searchResult.listings[i];
        try {
          await randomDelay();
          
          jobLogger.info(`Processing listing ${i + 1}/${maxListings}: ${listing.url}`);
          const detailData = await scraper.scrapeDetailPage(page, listing.url);
          
          const propertyData: PropertyData = {
            site_id: source,
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
            jobLogger.info(`New property saved: ${result.propertyId}`);
          } else {
            updatedCount++;
            jobLogger.info(`Property updated: ${result.propertyId}`);
          }
        } catch (error) {
          failedCount++;
          jobLogger.error(`Failed to process listing`, { 
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
      
      jobLogger.info(`Scrape completed: ${newCount} new, ${updatedCount} updated, ${failedCount} failed`);

    } finally {
      await browserPool.closePage(page);
    }

  } catch (error) {
    jobLogger.error(`Scraper failed`, { 
      error: error instanceof Error ? error.message : String(error) 
    });
    
    await updateJobStatus(jobId, "failed", undefined, error instanceof Error ? error.message : String(error));
  }
}

export async function runTestScrape(source: ScraperSource, filters?: ScraperFilters): Promise<{
  searchUrl: string;
  listingsFound: number;
  sampleListings: Array<{
    source_id: string;
    title: string;
    price: number;
    city: string;
    url: string;
  }>;
  detailSample: Record<string, unknown> | null;
  error?: string;
}> {
  const scraperClass = SCRAPER_MAP[source];
  if (!scraperClass) {
    throw new Error(`Unknown scraper source: ${source}`);
  }

  const testLogger = {
    info: (msg: string) => logger.info(`[TEST] ${msg}`),
    warn: (msg: string) => logger.warn(`[TEST] ${msg}`),
    error: (msg: string) => logger.error(`[TEST] ${msg}`),
  };

  const scraper = new scraperClass(testLogger);
  const page = await browserPool.createPage();

  try {
    await handleCookieConsent(page);
    
    const searchUrl = scraper.buildSearchUrl(filters);
    logger.info(`[TEST] Search URL: ${searchUrl}`);
    
    const searchResult = await scraper.scrapeSearchPage(page, searchUrl);
    logger.info(`[TEST] Found ${searchResult.totalFound} listings`);

    let detailSample: Record<string, unknown> | null = null;
    if (searchResult.listings.length > 0) {
      const firstListing = searchResult.listings[0];
      logger.info(`[TEST] Testing detail page: ${firstListing.url}`);
      try {
        detailSample = await scraper.scrapeDetailPage(page, firstListing.url);
      } catch (error) {
        logger.error(`[TEST] Detail scrape failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      searchUrl,
      listingsFound: searchResult.totalFound,
      sampleListings: searchResult.listings.slice(0, 3).map(l => ({
        source_id: l.source_id,
        title: l.title,
        price: l.price,
        city: l.city,
        url: l.url,
      })),
      detailSample,
    };
  } catch (error) {
    return {
      searchUrl: scraper.buildSearchUrl(filters),
      listingsFound: 0,
      sampleListings: [],
      detailSample: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await browserPool.closePage(page);
  }
}