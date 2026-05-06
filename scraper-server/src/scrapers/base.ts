import { Page } from "puppeteer-core";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { randomDelay, sleep } from "../utils/retry.js";
import { handleCookieConsent, interceptResponses, InterceptedResponse } from "../browser/manager.js";
import { validatePropertyData, validateRawListing, ValidationResult, RawListing, ValidatedPropertyData } from "../utils/validation.js";
import { PropertyData, saveProperty } from "../appwrite/client.js";

// ─────────────────────────────────────────────
// SCRAPER FILTERS
// ─────────────────────────────────────────────

export interface ScraperFilters {
  city?: string;
  province?: string;
  price_min?: number;
  price_max?: number;
  type?: string;
  bedrooms_min?: number;
}

// ─────────────────────────────────────────────
// SCRAPE RESULT
// ─────────────────────────────────────────────

export interface ScrapeResult {
  listings: RawListing[];
  errors: string[];
  stats: {
    pagesScraped: number;
    totalFound: number;
    validated: number;
    skipped: number;
    missingFields: Record<string, number>;
  };
}

// ─────────────────────────────────────────────
// JOB LOGGER INTERFACE
// ─────────────────────────────────────────────

export interface JobLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  debug: (msg: string, meta?: Record<string, unknown>) => void;
}

// ─────────────────────────────────────────────
// ABSTRACT BASE SCRAPER
// ─────────────────────────────────────────────

export abstract class BaseScraper {
  protected siteId: string;
  protected source: string;
  protected filters: ScraperFilters;
  protected jobLogger: JobLogger;
  protected maxPages: number;

  constructor(source: string, siteId: string, filters: ScraperFilters, jobLogger: JobLogger) {
    this.source = source;
    this.siteId = siteId;
    this.filters = filters;
    this.jobLogger = jobLogger;
    this.maxPages = config.scraper.maxPages;
  }

  // ─────────────────────────────────────────────
  // ABSTRACT METHODS (must be implemented by each scraper)
  // ─────────────────────────────────────────────

  /** Build the search URL with filters applied */
  protected abstract buildSearchUrl(page: number): string;

  /** Parse the search results page (API response or HTML) and return listing URLs/IDs */
  protected abstract parseSearchResults(page: Page, apiResponses: InterceptedResponse[]): Promise<SearchResultItem[]>;

  /** Extract full property data from a detail page */
  protected abstract extractDetailData(page: Page, item: SearchResultItem, apiResponses: InterceptedResponse[]): Promise<RawListing | null>;

  /** Get the API URL pattern to intercept for this site */
  protected abstract getApiPattern(): string | RegExp;

  // ─────────────────────────────────────────────
  // MAIN SCRAPE LOOP
  // ─────────────────────────────────────────────

  async scrape(puppeteerPage: Page): Promise<ScrapeResult> {
    const result: ScrapeResult = {
      listings: [],
      errors: [],
      stats: {
        pagesScraped: 0,
        totalFound: 0,
        validated: 0,
        skipped: 0,
        missingFields: {},
      },
    };

    this.jobLogger.info(`Starting scrape for ${this.source}`, { filters: this.filters, maxPages: this.maxPages });

    // ─────────────────────────────────────────────
    // PHASE 1: Collect listing items from search pages
    // ─────────────────────────────────────────────

    const allItems: SearchResultItem[] = [];

    for (let pageNum = 1; pageNum <= this.maxPages; pageNum++) {
      try {
        const searchUrl = this.buildSearchUrl(pageNum);
        this.jobLogger.info(`Navigating to search page ${pageNum}`, { url: searchUrl });

        // Set up API interception before navigation
        const apiResponses = interceptResponses(puppeteerPage, this.getApiPattern());

        await puppeteerPage.goto(searchUrl, {
          waitUntil: "networkidle2",
          timeout: config.browser.timeout,
        });

        // Handle cookie consent
        await handleCookieConsent(puppeteerPage);

        // Wait a bit for any delayed API responses
        await sleep(2000);

        // Parse search results
        const items = await this.parseSearchResults(puppeteerPage, apiResponses);

        this.jobLogger.info(`Found ${items.length} items on page ${pageNum}`, {
          totalSoFar: allItems.length + items.length,
        });

        if (items.length === 0) {
          this.jobLogger.info(`No more results on page ${pageNum}, stopping pagination`);
          break;
        }

        allItems.push(...items);
        result.stats.pagesScraped++;

        // Random delay between pages
        if (pageNum < this.maxPages) {
          await randomDelay();
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.jobLogger.error(`Failed to scrape search page ${pageNum}`, { error: msg });
        result.errors.push(`Search page ${pageNum}: ${msg}`);
        // Continue to next page
      }
    }

    result.stats.totalFound = allItems.length;
    this.jobLogger.info(`Total items found: ${allItems.length}`, { pagesScraped: result.stats.pagesScraped });

    // ─────────────────────────────────────────────
    // PHASE 2: Extract detail data for each listing
    // ─────────────────────────────────────────────

    for (let i = 0; i < allItems.length; i++) {
      const item = allItems[i];

      try {
        // Navigate to detail page
        const detailUrl = item.url;
        this.jobLogger.debug(`Extracting detail ${i + 1}/${allItems.length}`, { url: detailUrl });

        // Set up API interception for detail page
        const detailApiResponses = interceptResponses(puppeteerPage, this.getApiPattern());

        await puppeteerPage.goto(detailUrl, {
          waitUntil: "networkidle2",
          timeout: config.scraper.detailTimeout,
        });

        // Wait for dynamic content
        await sleep(1500);

        // Extract data
        const rawListing = await this.extractDetailData(puppeteerPage, item, detailApiResponses);

        if (!rawListing) {
          result.errors.push(`No data extracted: ${detailUrl}`);
          result.stats.skipped++;
          continue;
        }

        // Validate raw listing
        const validation = validateRawListing(rawListing);

        if (!validation.success) {
          this.jobLogger.warn(`Invalid listing data for ${detailUrl}`, { errors: validation.errors });
          result.errors.push(`Validation failed: ${detailUrl} — ${validation.errors.join(", ")}`);
          result.stats.skipped++;
          continue;
        }

        // Track missing fields
        const validated = validation.data!;
        if (validated.city === "") result.stats.missingFields["city"] = (result.stats.missingFields["city"] || 0) + 1;
        if (validated.surface_sqm === 0) result.stats.missingFields["surface_sqm"] = (result.stats.missingFields["surface_sqm"] || 0) + 1;
        if (validated.bedrooms === 0) result.stats.missingFields["bedrooms"] = (result.stats.missingFields["bedrooms"] || 0) + 1;
        if (validated.photos.length === 0) result.stats.missingFields["photos"] = (result.stats.missingFields["photos"] || 0) + 1;

        result.listings.push(validated);
        result.stats.validated++;

        // Random delay between detail pages
        if (i < allItems.length - 1) {
          await randomDelay();
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.jobLogger.error(`Failed to extract detail for ${item.url}`, { error: msg });
        result.errors.push(`Detail ${item.url}: ${msg}`);
        result.stats.skipped++;
        // Continue with next listing
      }
    }

    this.jobLogger.info(`Scrape complete for ${this.source}`, {
      totalFound: result.stats.totalFound,
      validated: result.stats.validated,
      skipped: result.stats.skipped,
      errors: result.errors.length,
      missingFields: result.stats.missingFields,
    });

    return result;
  }

  // ─────────────────────────────────────────────
  // SAVE LISTINGS TO APPWRITE
  // ─────────────────────────────────────────────

  async saveListings(listings: RawListing[]): Promise<{ newCount: number; updatedCount: number; failedCount: number }> {
    let newCount = 0;
    let updatedCount = 0;
    let failedCount = 0;

    for (const listing of listings) {
      try {
        const propertyData: PropertyData = {
          site_id: this.siteId,
          source_id: listing.source_id,
          url: listing.url,
          title: listing.title,
          description: listing.description,
          price: listing.price,
          surface_sqm: listing.surface_sqm,
          bedrooms: listing.bedrooms,
          bathrooms: listing.bathrooms,
          type: listing.type,
          city: listing.city,
          postal_code: listing.postal_code,
          province: listing.province,
          latitude: listing.latitude,
          longitude: listing.longitude,
          address: listing.address,
          photos: listing.photos,
          agent_name: listing.agent_name,
          agent_phone: listing.agent_phone,
          agent_agency: listing.agent_agency,
          amenities: listing.amenities,
          energy_rating: listing.energy_rating,
          year_built: listing.year_built || 0,
        };

        // Validate before saving
        const validation = validatePropertyData(propertyData);
        if (!validation.success) {
          this.jobLogger.warn(`Skipping invalid property ${listing.source_id}`, { errors: validation.errors });
          failedCount++;
          continue;
        }

        if (validation.warnings.length > 0) {
          this.jobLogger.debug(`Property ${listing.source_id} has warnings`, { warnings: validation.warnings });
        }

        const res = await saveProperty(propertyData);
        if (res.isNew) {
          newCount++;
        } else {
          updatedCount++;
        }
      } catch (error) {
        this.jobLogger.error(`Failed to save property ${listing.source_id}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        failedCount++;
      }
    }

    return { newCount, updatedCount, failedCount };
  }
}

// ─────────────────────────────────────────────
// SEARCH RESULT ITEM
// ─────────────────────────────────────────────

export interface SearchResultItem {
  source_id: string;
  url: string;
  /** Partial data from search results (may be enriched from detail page) */
  partial?: Partial<RawListing>;
}