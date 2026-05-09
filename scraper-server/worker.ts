/**
 * EDGE WORKER — Scrapes ERA and pushes to Appwrite directly.
 * Run this locally with: npx tsx worker.ts
 */
import { chromium } from "playwright";
import { EraScraper } from "./src/scrapers/era.js";
import { saveProperty, getSiteBySlug } from "./src/appwrite/client.js";
import { logger } from "./src/utils/logger.js";
import { randomDelay } from "./src/utils/retry.js";

const CONFIG = {
  source: "era" as const,
  city: process.env.WORKER_CITY || undefined,
  maxListings: parseInt(process.env.WORKER_MAX_LISTINGS || "10", 10),
  delayMs: parseInt(process.env.WORKER_DELAY_MS || "3000", 10),
  jitterMs: parseInt(process.env.WORKER_JITTER_MS || "2000", 10),
};

async function scrapeEra() {
  const scraper = new EraScraper({
    info: (msg: string) => logger.info(`[ERA] ${msg}`),
    warn: (msg: string) => logger.warn(`[ERA] ${msg}`),
    error: (msg: string) => logger.error(`[ERA] ${msg}`),
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    const url = scraper.buildSearchUrl({ city: CONFIG.city });
    logger.info(`Scraping: ${url}`);

    const result = await scraper.scrapeSearchPage(page, url);
    logger.info(`Found ${result.totalFound} listings`);

    if (result.totalFound === 0) {
      logger.warn("No listings found — ERA may have changed selectors or is temporarily empty");
      return { total: 0, new: 0, updated: 0, failed: 0 };
    }

    // Resolve site ID from Appwrite
    const siteDoc = await getSiteBySlug(CONFIG.source);
    if (!siteDoc) {
      throw new Error(`Site "${CONFIG.source}" not found in Appwrite. Create it first.`);
    }
    const siteId = siteDoc.$id;

    let newCount = 0, updatedCount = 0, failedCount = 0;
    const max = Math.min(result.listings.length, CONFIG.maxListings);

    for (let i = 0; i < max; i++) {
      const listing = result.listings[i];
      try {
        // Delay with jitter between requests
        const delay = CONFIG.delayMs + Math.random() * CONFIG.jitterMs;
        await new Promise((r) => setTimeout(r, delay));

        logger.info(`Processing ${i + 1}/${max}: ${listing.url}`);

        const detailPage = await browser.newPage();
        let detailData: any;
        try {
          detailData = await scraper.scrapeDetailPage(detailPage, listing.url);
        } finally {
          await detailPage.close();
        }

        const propertyData = {
          site_id: siteId,
          source_id: listing.source_id,
          url: listing.url,
          title: detailData.title || listing.title || "",
          description: detailData.description || "",
          price: detailData.price || listing.price || 0,
          surface_sqm: detailData.surface_sqm || 0,
          bedrooms: detailData.bedrooms || 0,
          bathrooms: detailData.bathrooms || 0,
          type: detailData.type || listing.type || "house",
          city: detailData.city || listing.city || "",
          postal_code: "",
          province: "",
          latitude: 0,
          longitude: 0,
          address: detailData.address || "",
          photos: detailData.photos || [],
          agent_name: "",
          agent_phone: "",
          agent_agency: "",
          amenities: [],
          energy_rating: "",
          year_built: null,
        };

        const result = await saveProperty(propertyData);
        if (result.isNew) newCount++;
        else updatedCount++;
      } catch (error) {
        failedCount++;
        logger.error(`Failed to process listing`, {
          url: listing.url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info(`Done: ${newCount} new, ${updatedCount} updated, ${failedCount} failed`);
    return { total: max, new: newCount, updated: updatedCount, failed: failedCount };
  } finally {
    await browser.close();
  }
}

// ─── MAIN ───
(async () => {
  logger.info("╔════════════════════════════════════════════╗");
  logger.info("║  ERA Edge Worker — starting scrape         ║");
  logger.info(`║  City: ${CONFIG.city || "ALL"}${" ".repeat(35 - (CONFIG.city?.length || 3))}║`);
  logger.info(`║  Max listings: ${CONFIG.maxListings}${" ".repeat(23)}║`);
  logger.info(`║  Delay: ${CONFIG.delayMs}-${CONFIG.delayMs + CONFIG.jitterMs}ms${" ".repeat(26)}║`);
  logger.info("╚════════════════════════════════════════════╝");

  const start = Date.now();
  try {
    const stats = await scrapeEra();
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(`Scrape completed in ${duration}s`);
    process.exit(0);
  } catch (error) {
    logger.error("Scrape crashed", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
})();
