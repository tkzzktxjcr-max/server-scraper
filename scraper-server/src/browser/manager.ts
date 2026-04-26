import puppeteer, { Browser, Page, BrowserContext } from "puppeteer";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

class BrowserPool {
  private browser: Browser | null = null;
  private contexts: BrowserContext[] = [];
  private maxContexts: number;
  private headless: boolean;

  constructor() {
    this.maxContexts = config.browser.maxPages;
    this.headless = config.browser.headless;
  }

  async getBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.connected) {
      logger.info("Launching new browser instance");
      this.browser = await puppeteer.launch({
        headless: this.headless ? "new" : false,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--disable-gpu",
          "--window-size=1920x1080",
        ],
      });

      this.browser.on("disconnected", () => {
        logger.warn("Browser disconnected");
        this.browser = null;
        this.contexts = [];
      });
    }
    return this.browser;
  }

  async createContext(): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    
    if (this.contexts.length >= this.maxContexts) {
      // Reuse the oldest context
      const oldest = this.contexts.shift();
      if (oldest) {
        this.contexts.push(oldest);
        return oldest;
      }
    }

    const context = await browser.createBrowserContext();
    this.contexts.push(context);
    return context;
  }

  async createPage(): Promise<Page> {
    const context = await this.createContext();
    const page = await context.newPage();
    
    // Set default timeout
    page.setDefaultTimeout(config.browser.timeout);
    page.setDefaultNavigationTimeout(config.browser.timeout);
    
    // Block images and CSS for faster loading
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const resourceType = request.resourceType();
      if (["image", "stylesheet", "font"].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    return page;
  }

  async closePage(page: Page): Promise<void> {
    try {
      await page.close();
    } catch (error) {
      logger.warn("Error closing page", { error });
    }
  }

  async cleanup(): Promise<void> {
    for (const context of this.contexts) {
      try {
        await context.close();
      } catch {
        // Context may already be closed
      }
    }
    this.contexts = [];

    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // Browser may already be closed
      }
      this.browser = null;
    }
  }
}

// Singleton instance
export const browserPool = new BrowserPool();

// Graceful shutdown
process.on("SIGINT", async () => {
  logger.info("Received SIGINT, cleaning up browser pool...");
  await browserPool.cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info("Received SIGTERM, cleaning up browser pool...");
  await browserPool.cleanup();
  process.exit(0);
});
