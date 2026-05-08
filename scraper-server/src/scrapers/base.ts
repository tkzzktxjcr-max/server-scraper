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
  abstract interceptApiListings(page: Page, timeoutMs?: number): Promise<SearchResultItem[]>;

  async scrapeSearchPage(page: Page, searchUrl: string): Promise<ScrapeResult> {
    this.logger.info(`Navigating to: ${searchUrl}`);
    
    // ── FIX: Set up API interception FIRST, before navigation ──
    const apiPromise = this.interceptApiListings(page, 15000);
    
    // Navigate
    try {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (error) {
      this.logger.warn("Initial navigation timeout", { error: error instanceof Error ? error.message : String(error) });
      await page.goto(searchUrl, { waitUntil: "commit", timeout: 60000 });
    }
    
    // Check for blocking
    const isBlocked = await this.isBlocked(page);
    if (isBlocked) {
      this.logger.warn("Page appears to be blocked, waiting extra time...");
      await page.waitForTimeout(20000);
      
      // Try to handle any challenge
      await this.handleChallenge(page);
    }
    
    // Handle cookie consent
    const { handleCookieConsent } = await import("../browser/playwright-manager.js");
    await handleCookieConsent(page);
    
    // Wait for content to settle
    await page.waitForTimeout(5000);
    
    // Scroll to trigger lazy loading (and trigger more API calls)
    await scrollToBottom(page);
    await page.waitForTimeout(3000);
    
    // Await API interception results
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
      
      // Log page info for debugging
      const title = await page.title().catch(() => "unknown");
      const url = page.url();
      this.logger.warn(`Page debug info`, { title, url });
    }
    
    return {
      listings,
      totalFound: listings.length,
    };
  }

  private async isBlocked(page: Page): Promise<boolean> {
    try {
      const title = await page.title();
      const content = await page.content();
      return title.includes("Just a moment") || 
             title.includes("Access Denied") ||
             title.includes("Forbidden") ||
             content.includes("cf-browser-verification") ||
             content.includes("challenge-platform") ||
             content.includes("turnstile") ||
             content.includes("Checking your browser") ||
             content.includes("blocked") ||
             content.includes("robot") ||
             content.includes("captcha");
    } catch {
      return false;
    }
  }

  private async handleChallenge(page: Page): Promise<void> {
    try {
      // Try to click any checkbox (Cloudflare challenge)
      const checkbox = page.locator('input[type="checkbox"]').first();
      if (await checkbox.isVisible({ timeout: 5000 }).catch(() => false)) {
        await checkbox.click();
        await page.waitForTimeout(15000);
      }
    } catch {}
  }

  async scrapeDetailPage(page: Page, detailUrl: string): Promise<Partial<PropertyData>> {
    this.logger.info(`Navigating to detail: ${detailUrl}`);
    try {
      await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch {
      await page.goto(detailUrl, { waitUntil: "commit", timeout: 60000 });
    }
    await page.waitForTimeout(5000);
    return this.extractDetailFromDom(page);
  }
}