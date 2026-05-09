import { chromium } from "playwright";
import { ImmovlanScraper } from "./src/scrapers/immovlan.js";

async function test() {
  const logger = {
    info: (msg: string) => console.log(`[INFO] ${msg}`),
    warn: (msg: string) => console.log(`[WARN] ${msg}`),
    error: (msg: string) => console.log(`[ERROR] ${msg}`),
  };
  const scraper = new ImmovlanScraper(logger);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    const url = scraper.buildSearchUrl({ city: "Brussels" });
    console.log(`=== Testing Immovlan: ${url} ===\n`);
    const result = await scraper.scrapeSearchPage(page, url);
    console.log(`\n=== RESULT === Found: ${result.totalFound} listings`);
    if (result.listings[0]) {
      console.log("\n=== Sample ===");
      console.log(JSON.stringify(result.listings[0], null, 2));
    }
    process.exit(result.totalFound > 0 ? 0 : 1);
  } catch (e) {
    console.error("❌ CRASH:", e);
    process.exit(1);
  } finally {
    await browser.close();
  }
}
test();
