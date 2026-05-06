import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Browser, Page, BrowserContext } from "puppeteer-core";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// ─────────────────────────────────────────────
// STEALTH PLUGIN
// ─────────────────────────────────────────────

puppeteer.use(StealthPlugin());

// ─────────────────────────────────────────────
// USER AGENT ROTATION
// ─────────────────────────────────────────────

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",
];

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ─────────────────────────────────────────────
// BROWSER POOL
// ─────────────────────────────────────────────

class BrowserPool {
  private browser: Browser | null = null;
  private contexts: BrowserContext[] = [];
  private maxContexts: number;
  private isLaunching = false;

  constructor() {
    this.maxContexts = config.browser.maxPages;
  }

  async getBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;

    if (this.isLaunching) {
      while (this.isLaunching) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this.browser?.connected) return this.browser;
    }

    this.isLaunching = true;
    try {
      logger.info("Launching stealth browser", { headless: config.browser.headless });

      const launchArgs = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1920,1080",
      ];

      // Proxy configuration
      if (config.proxy.enabled && config.proxy.url) {
        launchArgs.push(`--proxy-server=${config.proxy.url}`);
        logger.info("Proxy enabled", { url: config.proxy.url });
      }

      this.browser = await puppeteer.launch({
        headless: config.browser.headless ? "new" : false,
        args: launchArgs,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        defaultViewport: { width: 1920, height: 1080 },
      });

      this.browser.on("disconnected", () => {
        this.browser = null;
        this.contexts = [];
        logger.warn("Browser disconnected");
      });

      logger.info("Stealth browser launched successfully");
      return this.browser;
    } finally {
      this.isLaunching = false;
    }
  }

  async createPage(): Promise<Page> {
    const browser = await this.getBrowser();

    // Reuse or create context
    if (this.contexts.length >= this.maxContexts) {
      const old = this.contexts.shift();
      try {
        await old!.close();
      } catch {
        // ignore
      }
    }

    const context = await browser.createBrowserContext();
    this.contexts.push(context);

    const page = await context.newPage();

    // Set random user agent
    const ua = getRandomUserAgent();
    await page.setUserAgent(ua);

    // Set timeouts
    page.setDefaultTimeout(config.browser.timeout);
    page.setDefaultNavigationTimeout(config.browser.timeout);

    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    // Proxy authentication
    if (config.proxy.enabled && config.proxy.username && config.proxy.password) {
      await page.authenticate({
        username: config.proxy.username,
        password: config.proxy.password,
      });
    }

    // Set extra HTTP headers to look more natural
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9,nl;q=0.8,fr;q=0.7",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Sec-Ch-Ua": '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
    });

    logger.debug("Created new page with stealth settings", { userAgent: ua.substring(0, 50) + "..." });
    return page;
  }

  async closePage(page: Page): Promise<void> {
    try {
      const context = page.browserContext();
      await page.close();
      const idx = this.contexts.indexOf(context);
      if (idx > -1) this.contexts.splice(idx, 1);
      try {
        await context.close();
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
  }

  async cleanup(): Promise<void> {
    logger.info("Cleaning up browser pool...");
    for (const ctx of this.contexts) {
      try {
        await ctx.close();
      } catch {
        // ignore
      }
    }
    this.contexts = [];
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // ignore
      }
      this.browser = null;
    }
    logger.info("Browser pool cleaned");
  }

  getStatus(): { activeContexts: number; maxContexts: number; connected: boolean } {
    return {
      activeContexts: this.contexts.length,
      maxContexts: this.maxContexts,
      connected: this.browser?.connected || false,
    };
  }
}

// ─────────────────────────────────────────────
// COOKIE CONSENT HANDLER
// ─────────────────────────────────────────────

export async function handleCookieConsent(page: Page): Promise<void> {
  try {
    // Common cookie consent selectors for Belgian real estate sites
    const consentSelectors = [
      // Immoweb
      '#unblu-cookies-accept-button',
      'button[id*="accept-cookies"]',
      'button[data-testid="cookie-accept"]',
      // Generic
      'button#onetrust-accept-btn-handler',
      'button[class*="accept-cookies"]',
      'button[class*="cookie-accept"]',
      'a[class*="cookie-accept"]',
      '#didomi-notice-agree-button',
      'button[aria-label*="Accept"]',
      'button[aria-label*="accept"]',
      'button[aria-label*="Accept all"]',
      // Zimmo
      'button[class*="js-cookie-consent-accept"]',
      // Immovlan
      'button[class*="cookie-consent-accept"]',
      '.cookie-consent button:first-child',
    ];

    for (const selector of consentSelectors) {
      try {
        const button = await page.$(selector);
        if (button) {
          const isVisible = await button.isIntersectingViewport().catch(() => false);
          if (isVisible) {
            await button.click();
            logger.debug("Cookie consent accepted", { selector });
            await new Promise((r) => setTimeout(r, 1000));
            return;
          }
        }
      } catch {
        // continue to next selector
      }
    }

    logger.debug("No cookie consent banner found or already accepted");
  } catch (error) {
    logger.debug("Cookie consent handling failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

// ─────────────────────────────────────────────
// API RESPONSE INTERCEPTOR
// ─────────────────────────────────────────────

export interface InterceptedResponse {
  url: string;
  status: number;
  body: unknown;
}

export function interceptResponses(
  page: Page,
  urlPattern: string | RegExp
): Promise<InterceptedResponse[]> {
  const responses: InterceptedResponse[] = [];

  page.on("response", async (response) => {
    const url = response.url();
    const matches = typeof urlPattern === "string"
      ? url.includes(urlPattern)
      : urlPattern.test(url);

    if (matches) {
      try {
        const contentType = response.headers()["content-type"] || "";
        if (contentType.includes("application/json")) {
          const body = await response.json();
          responses.push({ url, status: response.status(), body });
        }
      } catch {
        // Not JSON or failed to parse — skip
      }
    }
  });

  // Return a promise that resolves with the collected responses
  // The caller should await navigation first, then read from the returned array
  return Promise.resolve(responses);
}

// ─────────────────────────────────────────────
// SINGLETON
// ─────────────────────────────────────────────

export const browserPool = new BrowserPool();

process.on("SIGINT", () => browserPool.cleanup());
process.on("SIGTERM", () => browserPool.cleanup());