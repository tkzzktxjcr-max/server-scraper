/**
 * Test script: Run a real scrape on immoweb to verify the fixes work.
 */
import { chromium } from "playwright";
import { ImmowebScraper } from "./src/scrapers/immoweb.js";

async function testScrape() {
  const logger = {
    info: (msg: string, meta?: Record<string, unknown>) => console.log(`[INFO] ${msg}`, meta || ""),
    warn: (msg: string, meta?: Record<string, unknown>) => console.log(`[WARN] ${msg}`, meta || ""),
    error: (msg: string, meta?: Record<string, unknown>) => console.log(`[ERROR] ${msg}`, meta || ""),
  };

  const scraper = new ImmowebScraper(logger);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const url = scraper.buildSearchUrl({ city: "Brussels" });
    console.log(`Testing: ${url}\n`);
    
    const result = await scraper.scrapeSearchPage(page, url);
    console.log(`\n=== RESULT ===`);
    console.log(`Total found: ${result.totalFound}`);
    console.log(`Listings: ${result.listings.length}`);
    
    if (result.listings.length > 0) {
      console.log("\n=== Sample Listing ===");
      console.log(JSON.stringify(result.listings[0], null, 2));
    }
    
    if (result.listings.length > 0) {
      console.log("\n✅ SUCCESS: Listings found!");
      process.exit(0);
    } else {
      console.log("\n❌ FAILURE: 0 listings found — possible site blocking or DOM change");
      process.exit(1);
    }
  } catch (e) {
    console.error("\n❌ CRASH:", e);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

testScrape();
