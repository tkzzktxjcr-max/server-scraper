import { Page } from "puppeteer-core";
import { InterceptedResponse, interceptResponses } from "../browser/manager.js";
import { RawListing } from "../utils/validation.js";
import { PropertyData } from "../appwrite/client.js";

export interface ScraperFilters {
  city?: string;
  province?: string;
  price_min?: number;
  price_max?: number;
  type?: string;
  bedrooms_min?: number;
  [key: string]: unknown;
}

export interface JobLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface SearchResultItem {
  source_id: string;
  url: string;
  title: string;
  price: number;
  city: string;
  type: string;
  bedrooms?: number;
  surface_sqm?: number;
}

export interface ScrapeResult {
  listings: RawListing[];
  totalFound: number;
}

export abstract class BaseScraper {
  protected siteSlug: string;
  public baseUrl: string;
  protected logger: JobLogger;

  constructor(siteSlug: string, baseUrl: string, logger: JobLogger) {
    this.siteSlug = siteSlug;
    this.baseUrl = baseUrl;
    this.logger = logger;
  }

  abstract getApiPattern(): string | RegExp;
  abstract parseSearchResults(responses: InterceptedResponse[]): SearchResultItem[];
  abstract extractDetailData(responses: InterceptedResponse[], url: string): Promise<Partial<PropertyData>>;
  abstract buildSearchUrl(filters?: ScraperFilters): string;

  async scrapeSearchPage(page: Page, searchUrl: string): Promise<ScrapeResult> {
    this.logger.info(`Navigating to search: ${searchUrl}`);
    
    const apiResponses = await interceptResponses(page, this.getApiPattern());
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 60000 });
    
    await new Promise(r => setTimeout(r, 3000));
    
    const results = this.parseSearchResults(apiResponses);
    
    this.logger.info(`Parsed ${results.length} listings from API responses`);
    
    return {
      listings: results as unknown as RawListing[],
      totalFound: results.length,
    };
  }

  async scrapeDetailPage(page: Page, detailUrl: string): Promise<Partial<PropertyData>> {
    this.logger.info(`Navigating to detail: ${detailUrl}`);
    
    const detailApiResponses = await interceptResponses(page, this.getApiPattern());
    await page.goto(detailUrl, { waitUntil: "networkidle2", timeout: 60000 });
    
    await new Promise(r => setTimeout(r, 2000));
    
    return this.extractDetailData(detailApiResponses, detailUrl);
  }
}