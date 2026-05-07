import { Page } from "playwright";
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
  listings: SearchResultItem[];
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

  abstract buildSearchUrl(filters?: ScraperFilters): string;
  abstract extractListingsFromDom(page: Page): Promise<SearchResultItem[]>;
  abstract extractDetailFromDom(page: Page): Promise<Partial<PropertyData>>;

  async scrapeSearchPage(page: Page, searchUrl: string): Promise<ScrapeResult> {
    this.logger.info(`Navigating to: ${searchUrl}`);
    
    await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(3000);
    
    const results = await this.extractListingsFromDom(page);
    this.logger.info(`Extracted ${results.length} listings from DOM`);
    
    return {
      listings: results,
      totalFound: results.length,
    };
  }

  async scrapeDetailPage(page: Page, detailUrl: string): Promise<Partial<PropertyData>> {
    this.logger.info(`Navigating to detail: ${detailUrl}`);
    await page.goto(detailUrl, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(2000);
    return this.extractDetailFromDom(page);
  }
}