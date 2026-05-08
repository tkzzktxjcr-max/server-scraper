import { chromium, Browser, BrowserContext, Page } from "playwright";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
];

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

class PlaywrightBrowserPool {
  private browser: Browser | null = null;
  private contexts: BrowserContext[] = [];
  private maxContexts = 5;
  private isLaunching = false;

  async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    if (this.isLaunching) {
      while (this.isLaunching) await new Promise(r => setTimeout(r, 100));
      if (this.browser?.isConnected()) return this.browser;
    }

    this.isLaunching = true;
    try {
      logger.info("Launching Playwright browser");
      
      this.browser = await chromium.launch({
        headless: config.browser.headless,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-blink-features=AutomationControlled",
          "--window-size=1920,1080",
          "--disable-web-security",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-site-isolation-trials",
          "--disable-extensions",
          "--disable-default-apps",
          "--no-first-run",
          "--no-default-browser-check",
          "--password-store=basic",
          "--use-mock-keychain",
        ],
      });
      logger.info("Playwright browser launched");
      return this.browser;
    } finally {
      this.isLaunching = false;
    }
  }

  async createPage(): Promise<Page> {
    const browser = await this.getBrowser();

    if (this.contexts.length >= this.maxContexts) {
      const old = this.contexts.shift();
      if (old) await old.close().catch(() => {});
    }

    const context = await browser.newContext({
      userAgent: getRandomUserAgent(),
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      timezoneId: "Europe/Brussels",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9,nl;q=0.8,fr;q=0.7",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    this.contexts.push(context);
    const page = await context.newPage();
    
    // Inject anti-detection script
    await page.addInitScript(() => {
      // Override navigator.webdriver
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
      
      // Override permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters: PermissionDescriptor) => {
        if (parameters.name === 'notifications') {
          return Promise.resolve({ state: 'prompt' } as unknown as PermissionStatus);
        }
        return originalQuery(parameters);
      };
      
      // Override plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });
      
      // Override languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en', 'nl', 'fr'],
      });
    });
    
    page.setDefaultTimeout(config.browser.timeout);
    page.setDefaultNavigationTimeout(config.browser.timeout);
    return page;
  }

  async closePage(page: Page): Promise<void> {
    try {
      const context = page.context();
      await page.close();
      const idx = this.contexts.indexOf(context);
      if (idx > -1) this.contexts.splice(idx, 1);
      await context.close().catch(() => {});
    } catch {}
  }

  async cleanup(): Promise<void> {
    for (const ctx of this.contexts) await ctx.close().catch(() => {});
    this.contexts = [];
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  getStatus() {
    return {
      activeContexts: this.contexts.length,
      maxContexts: this.maxContexts,
      connected: this.browser?.isConnected() || false,
    };
  }
}

export const browserPool = new PlaywrightBrowserPool();

export async function handleCookieConsent(page: Page): Promise<void> {
  const consentSelectors = [
    'button[id*="accept"]',
    'button[data-testid*="cookie"]',
    'button[aria-label*="Accept"]',
    'button[aria-label*="accept"]',
    '#didomi-notice-agree-button',
    'button[class*="cookie"]',
    '.cookie-consent button',
    '[id*="onetrust-accept"]',
    '[class*="onetrust-accept"]',
    'button:has-text("Accept")',
    'button:has-text("Accepter")',
    'button:has-text("Akkoord")',
    'button:has-text("I agree")',
    'button:has-text("Allow")',
    'button:has-text("Tout accepter")',
    'button:has-text("Accept all")',
    'button:has-text("Accepteer")',
  ];

  for (const selector of consentSelectors) {
    try {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(1500);
        return;
      }
    } catch {}
  }
}

export async function takeDebugScreenshot(page: Page, name: string): Promise<string> {
  const fs = await import("fs/promises");
  const path = await import("path");
  const dir = path.join(process.cwd(), "debug-screenshots");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${name}-${Date.now()}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

export async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
  await page.waitForTimeout(1000);
}