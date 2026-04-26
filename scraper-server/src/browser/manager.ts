import puppeteer, { Browser, Page, BrowserContext } from "puppeteer";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// ─────────────────────────────────────────────
// BROWSER POOL CLASS
// ─────────────────────────────────────────────

class BrowserPool {
  private browser: Browser | null = null;
  private contexts: BrowserContext[] = [];
  private maxContexts: number;
  private headless: boolean;
  private isLaunching = false;

  constructor() {
    this.maxContexts = config.browser.maxPages;
    this.headless = config.browser.headless;
  }

  /**
   * Get or create browser instance
   */
  async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.connected) {
      return this.browser;
    }

    // Prevent multiple launch attempts
    if (this.isLaunching) {
      // Wait for existing launch attempt
      while (this.isLaunching) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (this.browser && this.browser.connected) {
        return this.browser;
      }
    }

    this.isLaunching = true;
    
    try {
      logger.info("Launching new browser instance", { 
        headless: this.headless,
        maxContexts: this.maxContexts 
      });

      this.browser = await puppeteer.launch({
        headless: this.headless ? "new" : false,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--disable-gpu",
          "--window-size=1920x1080",
          "--disable-web-security",
          "--disable-features=IsolateOrigins,site-per-process",
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      });

      this.browser.on("disconnected", () => {
        logger.warn("Browser disconnected");
        this.browser = null;
        this.contexts = [];
      });

      logger.info("Browser launched successfully");
      return this.browser;
    } finally {
      this.isLaunching = false;
    }
  }

  /**
   * Create a new browser context
   */
  async createContext(): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    
    if (this.contexts.length >= this.maxContexts) {
      // Close oldest context
      const oldest = this.contexts.shift();
      if (oldest) {
        try {
          await oldest.close();
        } catch {
          // Context may already be closed
        }
      }
    }

    const context = await browser.createBrowserContext();
    this.contexts.push(context);
    return context;
  }

  /**
   * Create a new page
   */
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

    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    return page;
  }

  /**
   * Close a page
   */
  async closePage(page: Page): Promise<void> {
    try {
      await page.close();
    } catch (error) {
      logger.warn("Error closing page", { error });
    }
  }

  /**
   * Cleanup all browser resources
   */
  async cleanup(): Promise<void> {
    logger.info("Cleaning up browser pool...");

    // Close all contexts
    for (const context of this.contexts) {
      try {
        await context.close();
      } catch {
        // Context may already be closed
      }
    }
    this.contexts = [];

    // Close browser
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // Browser may already be closed
      }
      this.browser = null;
    }

    logger.info("Browser pool cleaned up");
  }

  /**
   * Get pool status
   */
  getStatus(): { activeContexts: number; maxContexts: number; connected: boolean } {
    return {
      activeContexts: this.contexts.length,
      maxContexts: this.maxContexts,
      connected: this.browser?.connected ?? false,
    };
  }
}

// Singleton instance
export const browserPool = new BrowserPool();

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────

const shutdownBrowser = async () => {
  logger.info("Shutting down browser...");
  await browserPool.cleanup();
};

process.on("SIGINT", shutdownBrowser);
process.on("SIGTERM", shutdownBrowser);