/**
 * HTTP-ONLY EDGE WORKER — Scrapes ERA and Immotop via pure HTTP (no Playwright).
 * Run locally: npx tsx worker-http.ts
 */
import { EraHttpScraper } from "./src/scrapers/era-http.js";
import { ImmotopScraper } from "./src/scrapers/immotop.js";
import { saveProperty, getSiteBySlug } from "./src/appwrite/client.js";
import { logger } from "./src/utils/logger.js";

const CONFIG = {
  sources: (process.env.WORKER_SOURCES || "era,immotop").split(","),
  city: process.env.WORKER_CITY || undefined,
  maxListings: parseInt(process.env.WORKER_MAX_LISTINGS || "20", 10),
  delayMs: parseInt(process.env.WORKER_DELAY_MS || "2000", 10),
  jitterMs: parseInt(process.env.WORKER_JITTER_MS || "2000", 10),
};

async function processListing(
  scraper: EraHttpScraper | ImmotopScraper,
  listing: any,
  siteId: string,
  source: string
): Promise<{ isNew: boolean; propertyId: string }> {
  // Fetch detail page
  await new Promise((r) => setTimeout(r, CONFIG.delayMs + Math.random() * CONFIG.jitterMs));

  let detailData: any;
  if (source === "era") {
    detailData = await (scraper as EraHttpScraper).scrapeDetailPage(listing.url);
  } else {
    detailData = await (scraper as ImmotopScraper).scrapeDetailPage(listing.url);
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
    postal_code: detailData.postal_code || "",
    province: detailData.province || "",
    latitude: detailData.latitude || 0,
    longitude: detailData.longitude || 0,
    address: detailData.address || "",
    photos: detailData.photos || [],
    agent_name: detailData.agent_name || "",
    agent_phone: detailData.agent_phone || "",
    agent_agency: detailData.agent_agency || "",
    amenities: detailData.amenities || [],
    energy_rating: detailData.energy_rating || "",
    year_built: detailData.year_built || null,
  };

  return await saveProperty(propertyData);
}

async function scrapeEra() {
  const scraper = new EraHttpScraper({
    info: (msg: string) => logger.info(`[ERA-HTTP] ${msg}`),
    warn: (msg: string) => logger.warn(`[ERA-HTTP] ${msg}`),
    error: (msg: string) => logger.error(`[ERA-HTTP] ${msg}`),
  });

  const siteDoc = await getSiteBySlug("era");
  if (!siteDoc) {
    throw new Error('Site "era" not found in Appwrite. Create it in scraping_sites collection.');
  }

  logger.info("Starting ERA HTTP scrape via sitemap...");
  const result = await scraper.run({ city: CONFIG.city });

  let newCount = 0, updatedCount = 0, failedCount = 0;
  const max = Math.min(result.listings.length, CONFIG.maxListings);

  for (let i = 0; i < max; i++) {
    const listing = result.listings[i];
    try {
      logger.info(`Processing ${i + 1}/${max}: ${listing.title || listing.url}`);
      const res = await processListing(scraper, listing, siteDoc.$id, "era");
      if (res.isNew) newCount++;
      else updatedCount++;
    } catch (error) {
      failedCount++;
      logger.error(`Failed: ${listing.url}`, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  logger.info(`ERA done: ${newCount} new, ${updatedCount} updated, ${failedCount} failed`);
  return { newCount, updatedCount, failedCount };
}

async function scrapeImmotop() {
  const scraper = new ImmotopScraper({
    info: (msg: string) => logger.info(`[IMMOTOP] ${msg}`),
    warn: (msg: string) => logger.warn(`[IMMOTOP] ${msg}`),
    error: (msg: string) => logger.error(`[IMMOTOP] ${msg}`),
  });

  const siteDoc = await getSiteBySlug("immotop");
  if (!siteDoc) {
    throw new Error('Site "immotop" not found in Appwrite. Create it in scraping_sites collection.');
  }

  logger.info("Starting Immotop HTTP scrape...");
  const url = scraper.buildSearchUrl({ city: CONFIG.city });
  const listings = await scraper.extractListings(url);

  let newCount = 0, updatedCount = 0, failedCount = 0;
  const max = Math.min(listings.length, CONFIG.maxListings);

  for (let i = 0; i < max; i++) {
    const listing = listings[i];
    try {
      logger.info(`Processing ${i + 1}/${max}: ${listing.title || listing.url}`);
      const res = await processListing(scraper, listing, siteDoc.$id, "immotop");
      if (res.isNew) newCount++;
      else updatedCount++;
    } catch (error) {
      failedCount++;
      logger.error(`Failed: ${listing.url}`, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  logger.info(`Immotop done: ${newCount} new, ${updatedCount} updated, ${failedCount} failed`);
  return { newCount, updatedCount, failedCount };
}

// ─── MAIN ───
(async () => {
  logger.info("╔════════════════════════════════════════════════════╗");
  logger.info("║  HTTP-Only Edge Worker — ERA + Immotop             ║");
  logger.info(`║  Sources: ${CONFIG.sources.join(", ")}${" ".repeat(38 - CONFIG.sources.join(", ").length)}║`);
  logger.info(`║  City: ${CONFIG.city || "ALL"}${" ".repeat(44 - (CONFIG.city?.length || 3))}║`);
  logger.info("╚════════════════════════════════════════════════════╝");

  const start = Date.now();
  try {
    for (const source of CONFIG.sources) {
      if (source === "era") await scrapeEra();
      else if (source === "immotop") await scrapeImmotop();
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
