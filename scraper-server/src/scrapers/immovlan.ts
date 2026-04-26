import { Page } from "puppeteer";
import { logger } from "../utils/logger.js";
import { delay } from "../utils/rate-limit.js";
import { PropertyData } from "../appwrite/client.js";
import { config } from "../config.js";

export interface ImmovlanListing {
  source_id: string;
  url: string;
  title: string;
  price: number;
  type: string;
  bedrooms: number;
  bathrooms: number;
  surface_sqm: number;
  address: string;
  city: string;
  postal_code: string;
  province: string;
  latitude: number;
  longitude: number;
  photos: string[];
  description: string;
  energy_rating: string;
  year_built: number;
  agent_name: string;
  agent_phone: string;
  agent_agency: string;
  amenities: string[];
}

export async function scrapeImmovlan(
  page: Page,
  filters: {
    city?: string;
    price_min?: number;
    price_max?: number;
    type?: string;
  } = {},
  jobLogger: ReturnType<typeof logger.info extends (msg: string, meta?: infer M) => void ? (msg: string, meta?: M) => { info: (msg: string, meta?: M) => void } : never>
): Promise<{ listings: ImmovlanListing[]; errors: string[] }> {
  const listings: ImmovlanListing[] = [];
  const errors: string[] = [];

  try {
    // Build URL with filters
    let url = "https://www.immovlan.be/en/search";
    const params: string[] = [];

    if (filters.city) {
      params.push(`query=${encodeURIComponent(filters.city)}`);
    }
    if (filters.price_min) {
      params.push(`price[min]=${filters.price_min}`);
    }
    if (filters.price_max) {
      params.push(`price[max]=${filters.price_max}`);
    }
    if (filters.type) {
      params.push(`property_type=${filters.type}`);
    }

    if (params.length > 0) {
      url += "?" + params.join("&");
    }

    jobLogger.info(`Navigating to: ${url}`);

    await page.goto(url, { waitUntil: "networkidle0", timeout: config.browser.timeout });
    await delay(2000);

    // Handle cookie consent
    try {
      const acceptBtn = await page.$("button#onetrust-accept-btn-handler");
      if (acceptBtn) {
        await acceptBtn.click();
        await delay(500);
      }
    } catch {
      // Cookie consent not present
    }

    // Scroll to load all listings
    let previousHeight = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = 5;

    while (scrollAttempts < maxScrollAttempts) {
      const currentHeight = await page.evaluate("document.body.scrollHeight");
      if (currentHeight === previousHeight) break;

      await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
      await delay(1500);
      previousHeight = currentHeight;
      scrollAttempts++;
    }

    // Extract listing links
    const listingLinks = await page.$$eval(
      "a.listing-item",
      (links) => (links as HTMLAnchorElement[]).map((link) => link.href)
    );

    jobLogger.info(`Found ${listingLinks.length} listings`);

    // Process each listing
    for (const link of listingLinks.slice(0, 20)) { // Limit to 20 for testing
      try {
        await page.goto(link, { waitUntil: "networkidle0", timeout: config.browser.timeout });
        await delay(config.rateLimit.delayMs);

        const listing = await extractImmovlanListing(page);
        if (listing) {
          listings.push(listing);
          jobLogger.info(`Scraped: ${listing.title} - €${listing.price}`);
        }
      } catch (error) {
        const errorMsg = `Failed to scrape ${link}: ${error}`;
        jobLogger.error(errorMsg);
        errors.push(errorMsg);
      }
    }
  } catch (error) {
    const errorMsg = `Immovlan scrape failed: ${error}`;
    jobLogger.error(errorMsg);
    errors.push(errorMsg);
  }

  return { listings, errors };
}

async function extractImmovlanListing(page: Page): Promise<ImmovlanListing | null> {
  try {
    const title = await page.$eval("h1", (el) => el.textContent?.trim() || "").catch(() => "");
    const priceText = await page.$eval(".price-value", (el) => el.textContent?.trim() || "").catch(() => "");
    const price = parseInt(priceText.replace(/[^0-9]/g, "") || "0", 10);

    // Extract property details from the page
    const detailsText = await page.evaluate(() => document.body.textContent || "");

    const bedrooms = extractNumber(detailsText, /(\d+)\s*bedroom/i) || 0;
    const bathrooms = extractNumber(detailsText, /(\d+)\s*bathroom/i) || extractNumber(detailsText, /(\d+)\s*bath/i) || 0;
    const surface = extractNumber(detailsText, /(\d+)\s*m²/i) || 0;

    // Extract address
    const address = await page.$eval(".address", (el) => el.textContent?.trim() || "").catch(() => "");

    // Extract photos
    const photos = await page.$$eval(".gallery img", (imgs) =>
      (imgs as HTMLImageElement[]).map((img) => img.src).filter((src) => src && !src.includes("placeholder"))
    );

    // Extract description
    const description = await page.$eval(".description", (el) => el.textContent?.trim() || "").catch(() => "");

    // Extract URL and source_id
    const url = page.url();
    const sourceIdMatch = url.match(/\/(\d+)\.html$/);
    const source_id = sourceIdMatch ? sourceIdMatch[1] : "";

    // Extract energy rating
    const energyRating = await page.$eval(".energy-class", (el) => el.textContent?.trim() || "G").catch(() => "G");

    // Extract agent info
    const agentName = await page.$eval(".contact-name", (el) => el.textContent?.trim() || "").catch(() => "");
    const agentPhone = await page.$eval(".contact-phone", (el) => el.textContent?.trim() || "").catch(() => "");
    const agentAgency = await page.$eval(".agency-name", (el) => el.textContent?.trim() || "").catch(() => "");

    return {
      source_id,
      url,
      title,
      price,
      type: "house",
      bedrooms,
      bathrooms,
      surface_sqm: surface,
      address,
      city: "",
      postal_code: "",
      province: "",
      latitude: 0,
      longitude: 0,
      photos: photos.slice(0, 10),
      description,
      energy_rating: energyRating.charAt(0).toUpperCase(),
      year_built: 0,
      agent_name: agentName,
      agent_phone: agentPhone,
      agent_agency: agentAgency,
      amenities: [],
    };
  } catch (error) {
    logger.error(`Failed to extract Immovlan listing: ${error}`);
    return null;
  }
}

function extractNumber(text: string, regex: RegExp): number {
  const match = text.match(regex);
  return match ? parseInt(match[1], 10) : 0;
}

export function toPropertyData(listing: ImmovlanListing, siteId: string): PropertyData {
  return {
    site_id: siteId,
    source_id: listing.source_id,
    url: listing.url,
    title: listing.title,
    description: listing.description,
    price: listing.price,
    surface_sqm: listing.surface_sqm,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    type: listing.type,
    city: listing.city,
    postal_code: listing.postal_code,
    province: listing.province,
    latitude: listing.latitude,
    longitude: listing.longitude,
    address: listing.address,
    photos: listing.photos,
    agent_name: listing.agent_name,
    agent_phone: listing.agent_phone,
    agent_agency: listing.agent_agency,
    amenities: listing.amenities,
    energy_rating: listing.energy_rating,
    year_built: listing.year_built,
  };
}
