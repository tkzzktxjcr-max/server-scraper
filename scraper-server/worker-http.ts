/**
 * HTTP-ONLY EDGE WORKER — Scrapes ERA, Immotop, Immovlan via pure HTTP.
 * No Playwright/Chromium needed. Works from any server.
 * Run: npx tsx worker-http.ts
 */
import { EraHttpScraper } from "./src/scrapers/era-http.js";
import { ImmotopScraper } from "./src/scrapers/immotop.js";
import { ImmovlanHttpScraper } from "./src/scrapers/immovlan-http.js";
import { saveProperty, getSiteBySlug } from "./src/appwrite/client.js";
import { logger } from "./src/utils/logger.js";

const CONFIG = {
  sources: (process.env.WORKER_SOURCES || "era,immotop,immovlan").split(","),
  city: process.env.WORKER_CITY || undefined,
  maxListings: parseInt(process.env.WORKER_MAX_LISTINGS || "20", 10),
  delayMs: parseInt(process.env.WORKER_DELAY_MS || "2000", 10),
  jitterMs: parseInt(process.env.WORKER_JITTER_MS || "2000", 10),
};

async function saveWithRetry(listing: any, siteId: string, detailData: any) {
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
    postal_code: detailData.postal_code || "",
    province: detailData.province || "",
    latitude: detailData.latitude || 0,
    longitude: detailData.longitude || 0,
    address: detailData.address || "",
    photos: detailData.photos || [],
    agent_name: detailData.agent_name || "",
    agent_phone: detailData.agent_phone || "",
    agent_agency: detailData.agent_agency || "",
    amenities: [],
    energy_rating: detailData.energy_rating || "",
    year_built: detailData.year_built || null,
  };
  return await saveProperty(propertyData);
}

async function scrapeEra() {
  const scraper = new EraHttpScraper({
    info: (msg: string) => logger.info(`[ERA] ${msg}`),
    warn: (msg: string) => logger.warn(`[ERA] ${msg}`),
    error: (msg: string) => logger.error(`[ERA] ${msg}`),
  });

  const siteDoc = await getSiteBySlug("era");
  if (!siteDoc) throw new Error('Site "era" not found in Appwrite.');
  const siteId = siteDoc.$id;

  logger.info("Starting ERA HTTP scrape via sitemap...");
  const result = await scraper.run({ city: CONFIG.city });

  let newCount = 0, updatedCount = 0, failedCount = 0;
  const max = Math.min(result.listings.length, CONFIG.maxListings);

  for (let i = 0; i < max; i++) {
    const listing = result.listings[i];
    try {
      await new Promise((r) => setTimeout(r, CONFIG.delayMs + Math.random() * CONFIG.jitterMs));
      logger.info(`[ERA] ${i + 1}/${max}: ${listing.title.substring(0, 50)}`);
      const detail = await scraper.scrapeDetailPage(listing.url);
      const res = await saveWithRetry(listing, siteId, detail);
      if (res.isNew) newCount++; else updatedCount++;
    } catch (error) {
      failedCount++;
      logger.error(`[ERA] Failed: ${listing.url}`);
    }
  }

  logger.info(`[ERA] Done: ${newCount} new, ${updatedCount} updated, ${failedCount} failed`);
}

async function scrapeImmotop() {
  const scraper = new ImmotopScraper({
    info: (msg: string) => logger.info(`[IMMOTOP] ${msg}`),
    warn: (msg: string) => logger.warn(`[IMMOTOP] ${msg}`),
    error: (msg: string) => logger.error(`[IMMOTOP] ${msg}`),
  });

  const siteDoc = await getSiteBySlug("immotop");
  if (!siteDoc) throw new Error('Site "immotop" not found in Appwrite.');
  const siteId = siteDoc.$id;

  logger.info("Starting Immotop HTTP scrape...");
  const url = scraper.buildSearchUrl({ city: CONFIG.city });
  const listings = await scraper.extractListings(url);

  let newCount = 0, updatedCount = 0, failedCount = 0;
  const max = Math.min(listings.length, CONFIG.maxListings);

  for (let i = 0; i < max; i++) {
    const listing = listings[i];
    try {
      await new Promise((r) => setTimeout(r, CONFIG.delayMs + Math.random() * CONFIG.jitterMs));
      logger.info(`[IMMOTOP] ${i + 1}/${max}: ${listing.title.substring(0, 50) || listing.url}`);
      const detail = await scraper.scrapeDetailPage(listing.url);
      const res = await saveWithRetry(listing, siteId, detail);
      if (res.isNew) newCount++; else updatedCount++;
    } catch (error) {
      failedCount++;
      logger.error(`[IMMOTOP] Failed: ${listing.url}`);
    }
  }

  logger.info(`[IMMOTOP] Done: ${newCount} new, ${updatedCount} updated, ${failedCount} failed`);
}

async function scrapeImmovlan() {
  const scraper = new ImmovlanHttpScraper({
    info: (msg: string) => logger.info(`[IMMOVLAN] ${msg}`),
    warn: (msg: string) => logger.warn(`[IMMOVLAN] ${msg}`),
    error: (msg: string) => logger.error(`[IMMOVLAN] ${msg}`),
  });

  const siteDoc = await getSiteBySlug("immovlan");
  if (!siteDoc) throw new Error('Site "immovlan" not found in Appwrite.');
  const siteId = siteDoc.$id;

  logger.info("Starting Immovlan HTTP scrape via sitemaps...");
  const result = await scraper.run({ city: CONFIG.city });

  let newCount = 0, updatedCount = 0, failedCount = 0;
  const max = Math.min(result.listings.length, CONFIG.maxListings);

  // For Immovlan, listings already contain detail data from the first fetch
  for (let i = 0; i < max; i++) {
    const listing = result.listings[i];
    try {
      logger.info(`[IMMOVLAN] ${i + 1}/${max}: ${listing.title.substring(0, 50)}`);
      // Re-fetch detail for full data
      const detail = await scraper.scrapeDetailPage(listing.url);
      const res = await saveWithRetry(listing, siteId, detail);
      if (res.isNew) newCount++; else updatedCount++;
    } catch (error) {
      failedCount++;
      logger.error(`[IMMOVLAN] Failed: ${listing.url}`);
    }
  }

  logger.info(`[IMMOVLAN] Done: ${newCount} new, ${updatedCount} updated, ${failedCount} failed`);
}

// ─── MAIN ───
(async () => {
  logger.info("╔═══════════════════════════════════════════════════════╗");
  logger.info("║  HTTP-Only Edge Worker — ERA + Immotop + Immovlan     ║");
  logger.info(`║  Sources: ${CONFIG.sources.join(", ")}${" ".repeat(Math.max(0, 36 - CONFIG.sources.join(", ").length))}║`);
  logger.info(`║  City: ${CONFIG.city || "ALL"}${" ".repeat(Math.max(0, 44 - (CONFIG.city?.length || 3)))}║`);
  logger.info(`║  Max listings/source: ${CONFIG.maxListings}${" ".repeat(Math.max(0, 28 - String(CONFIG.maxListings).length))}║`);
  logger.info("╚═══════════════════════════════════════════════════════╝");

  const start = Date.now();
  try {
    for (const source of CONFIG.sources) {
      if (source === "era") await scrapeEra();
      else if (source === "immotop") await scrapeImmotop();
      else if (source === "immovlan") await scrapeImmovlan();
      else logger.warn(`Unknown source: ${source}`);
    }
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(`All scrapes completed in ${duration}s`);
    process.exit(0);
  } catch (error) {
    logger.error("Worker crashed", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
})();