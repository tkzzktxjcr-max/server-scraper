import { Page } from "puppeteer";
import { logger } from "../utils/logger.js";
import { delay } from "../utils/rate-limit.js";
import { PropertyData } from "../appwrite/client.js";
import { config } from "../config.js";

export interface ImmowebListing {
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

export async function scrapeImmoweb(
  page: Page,
  filters: {
    city?: string;
    price_min?: number;
    price_max?: number;
    type?: string;
  } = {},
  jobLogger: ReturnType<typeof logger.info extends (msg: string, meta?: infer M) => void ? (msg: string, meta?: M) => { info: (msg: string, meta?: M) => void } : never>
): Promise<{ listings: ImmowebListing[]; errors: string[] }> {
  const listings: ImmowebListing[] = [];
  const errors: string[] = [];

  try {
    // Build URL with filters
    let url = "https://www.immoweb.be/en/search";
    const params: string[] = [];

    if (filters.city) {
      params.push(`&query=${encodeURIComponent(filters.city)}`);
    }
    if (filters.price_min) {
      params.push(`&priceMin=${filters.price_min}`);
    }
    if (filters.price_max) {
      params.push(`&priceMax=${filters.price_max}`);
    }
    if (filters.type) {
      params.push(`&propertyType=${filters.type}`);
    }

    if (params.length > 0) {
      url += "?" + params.join("&").replace("&", "");
    }

    jobLogger.info(`Navigating to: ${url}`);

    await page.goto(url, { waitUntil: "networkidle0", timeout: config.browser.timeout });
    await delay(2000); // Wait for dynamic content

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
      "a.search-results__item a.card__title-link",
      (links) => (links as HTMLAnchorElement[]).map((link) => link.href)
    );

    jobLogger.info(`Found ${listingLinks.length} listings`);

    // Process each listing
    for (const link of listingLinks) {
      try {
        await page.goto(link, { waitUntil: "networkidle0", timeout: config.browser.timeout });
        await delay(config.rateLimit.delayMs);

        const listing = await extractImmowebListing(page);
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
    const errorMsg = `Immoweb scrape failed: ${error}`;
    jobLogger.error(errorMsg);
    errors.push(errorMsg);
  }

  return { listings, errors };
}

async function extractImmowebListing(page: Page): Promise<ImmowebListing | null> {
  try {
    // Extract basic info
    const title = await page.$eval("h1.property-title", (el) => el.textContent?.trim() || "").catch(() => "");
    const priceText = await page.$eval(".price", (el) => el.textContent?.trim() || "").catch(() => "");
    const price = parseInt(priceText.replace(/[^0-9]/g, "") || "0", 10);

    // Extract property details
    const details = await page.$$eval(".property-details li", (lis) =>
      lis.map((li) => li.textContent?.trim() || "")
    );

    const bedrooms = extractNumber(details.join(" "), /(\d+)\s*bedroom/i);
    const bathrooms = extractNumber(details.join(" "), /(\d+)\s*bathroom/i);
    const surface = extractNumber(details.join(" "), /(\d+)\s*m²/i);

    // Extract location
    const address = await page.$eval(".address", (el) => el.textContent?.trim() || "").catch(() => "");
    const cityMatch = address.match(/,\s*([^,]+)$/);
    const city = cityMatch ? cityMatch[1].trim() : address;

    // Extract photos
    const photos = await page.$$eval(".property-gallery img", (imgs) =>
      (imgs as HTMLImageElement[]).map((img) => img.src).filter((src) => src && !src.includes("placeholder"))
    );

    // Extract description
    const description = await page.$eval(".property-description", (el) => el.textContent?.trim() || "").catch(() => "");

    // Extract energy rating
    const energyRating = await page.$eval(".energy-rating", (el) => el.textContent?.trim() || "G").catch(() => "G");

    // Extract agent info
    const agentName = await page.$eval(".agency-name", (el) => el.textContent?.trim() || "").catch(() => "");
    const agentPhone = await page.$eval(".agency-phone", (el) => el.textContent?.trim() || "").catch(() => "");
    const agentAgency = await page.$eval(".agency-logo img", (el) => el.getAttribute("alt") || "").catch(() => "");

    // Extract URL and source_id
    const url = page.url();
    const sourceIdMatch = url.match(/\/(\d+)\.html$/);
    const source_id = sourceIdMatch ? sourceIdMatch[1] : "";

    // Get coordinates if available
    let latitude = 0;
    let longitude = 0;
    const coordsScript = await page.$eval("script[data-property]", (el) => el.textContent).catch(() => null);
    if (coordsScript) {
      try {
        const data = JSON.parse(coordsScript);
        latitude = data.latitude || 0;
        longitude = data.longitude || 0;
      } catch {
        // Ignore JSON parse errors
      }
    }

    return {
      source_id,
      url,
      title,
      price,
      type: "house", // Default, would need more logic to determine
      bedrooms,
      bathrooms,
      surface_sqm: surface,
      address,
      city,
      postal_code: "",
      province: "",
      latitude,
      longitude,
      photos: photos.slice(0, 10), // Limit to 10 photos
      description,
      energy_rating: energyRating.charAt(0).toUpperCase(),
      year_built: 0,
      agent_name: agentName,
      agent_phone: agentPhone,
      agent_agency: agentAgency,
      amenities: [],
    };
  } catch (error) {
    logger.error(`Failed to extract listing: ${error}`);
    return null;
  }
}

function extractNumber(text: string, regex: RegExp): number {
  const match = text.match(regex);
  return match ? parseInt(match[1], 10) : 0;
}

export function toPropertyData(listing: ImmowebListing, siteId: string): PropertyData {
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
