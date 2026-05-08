import { Page } from "playwright";
import { PropertyData } from "../appwrite/client.js";
import { scrollToBottom, takeDebugScreenshot } from "../browser/playwright-manager.js";

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
  abstract interceptApiListings(page: Page): Promise<SearchResultItem[]>;

  async scrapeSearchPage(page: Page, searchUrl: string): Promise<ScrapeResult> {
    this.logger.info(`Navigating to: ${searchUrl}`);
    
    // Set up API interception before navigation
    const apiPromise = this.interceptApiListings(page).catch(() => [] as SearchResultItem[]);
    
    // Navigate with longer timeout
    try {
      await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 120000 });
    } catch {
      this.logger.warn("networkidle timeout, falling back to domcontentloaded");
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    }
    
    // Check for Cloudflare challenge
    const isChallenge = await this.isCloudflareChallenge(page);
    if (isChallenge) {
      this.logger.warn("Cloudflare challenge detected, waiting...");
      await page.waitForTimeout(15000);
      // Try clicking the challenge checkbox if present
      try {
        const challengeCheckbox = page.locator('input[type="checkbox"]').first();
        if (await challengeCheckbox.isVisible({ timeout: 5000 }).catch(() => false)) {
          await challengeCheckbox.click();
          await page.waitForTimeout(10000);
        }
      } catch {}
    }
    
    // Wait for initial render
    await page.waitForTimeout(5000);
    
    // Handle cookie consent
    const { handleCookieConsent } = await import("../browser/playwright-manager.js");
    await handleCookieConsent(page);
    
    // Wait for content to settle
    await page.waitForTimeout(8000);
    
    // Scroll to trigger lazy loading
    await scrollToBottom(page);
    await page.waitForTimeout(5000);
    
    // Try API interception first
    let listings = await apiPromise;
    this.logger.info(`API interception found ${listings.length} listings`);
    
    // Fallback to DOM extraction
    if (listings.length === 0) {
      listings = await this.extractListingsFromDom(page);
      this.logger.info(`DOM extraction found ${listings.length} listings`);
    }
    
    if (listings.length === 0) {
      const screenshotPath = await takeDebugScreenshot(page, `${this.siteSlug}-search-empty`);
      this.logger.warn(`0 listings found, screenshot saved: ${screenshotPath}`);
    }
    
    return {
      listings,
      totalFound: listings.length,
    };
  }

  private async isCloudflareChallenge(page: Page): Promise<boolean> {
    try {
      const title = await page.title();
      const content = await page.content();
      return title.includes("Just a moment") || 
             content.includes("cf-browser-verification") ||
             content.includes("challenge-platform") ||
             content.includes("turnstile") ||
             content.includes("Checking your browser");
    } catch {
      return false;
    }
  }

  async scrapeDetailPage(page: Page, detailUrl: string): Promise<Partial<PropertyData>> {
    this.logger.info(`Navigating to detail: ${detailUrl}`);
    try {
      await page.goto(detailUrl, { waitUntil: "networkidle", timeout: 120000 });
    } catch {
      await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    }
    await page.waitForTimeout(8000);
    return this.extractDetailFromDom(page);
  }
}