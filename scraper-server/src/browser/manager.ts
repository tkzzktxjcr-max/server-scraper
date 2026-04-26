// @ts-nocheck
import puppeteer from "puppeteer";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const Browser = puppeteer.Browser;
const Page = puppeteer.Page;

class BrowserPool {
  private browser: any = null;
  private contexts: any[] = [];
  private maxContexts: number;
  private isLaunching = false;

  constructor() {
    this.maxContexts = config.browser.maxPages;
  }

  async getBrowser() {
    if (this.browser?.connected) return this.browser;
    if (this.isLaunching) {
      while (this.isLaunching) await new Promise(r => setTimeout(r, 100));
      if (this.browser?.connected) return this.browser;
    }

    this.isLaunching = true;
    try {
      logger.info("Launching browser", { headless: config.browser.headless });
      this.browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      });
      this.browser.on("disconnected", () => { this.browser = null; this.contexts = []; });
      logger.info("Browser launched");
      return this.browser;
    } finally {
      this.isLaunching = false;
    }
  }

  async createPage() {
    const browser = await this.getBrowser();
    if (this.contexts.length >= this.maxContexts) {
      const old = this.contexts.shift();
      try { await old.close(); } catch {}
    }
    const context = await browser.createBrowserContext();
    this.contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(config.browser.timeout);
    page.setDefaultNavigationTimeout(config.browser.timeout);
    await page.setViewport({ width: 1920, height: 1080 });
    return page;
  }

  async closePage(page: any) {
    try { await page.close(); } catch {}
  }

  async cleanup() {
    logger.info("Cleaning up browser pool...");
    for (const ctx of this.contexts) { try { await ctx.close(); } catch {} }
    this.contexts = [];
    if (this.browser) { try { await this.browser.close(); } catch {} this.browser = null; }
    logger.info("Browser pool cleaned");
  }

  getStatus() {
    return { activeContexts: this.contexts.length, maxContexts: this.maxContexts, connected: this.browser?.connected || false };
  }
}

export const browserPool = new BrowserPool();
process.on("SIGINT", () => browserPool.cleanup());
process.on("SIGTERM", () => browserPool.cleanup());