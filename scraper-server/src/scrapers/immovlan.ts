// @ts-nocheck
import { Page } from "puppeteer";
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
  filters = {},
  jobLogger: any
): Promise<{ listings: ImmovlanListing[]; errors: string[] }> {
  const listings: ImmovlanListing[] = [];
  const errors: string[] = [];

  try {
    let url = "https://www.immovlan.be/en/search";
    
    jobLogger.info(`Navigating to: ${url}`);
    await page.goto(url, { waitUntil: "networkidle0", timeout: config.browser.timeout });
    await delay(2000);

    const listingLinks = await page.$$eval(
      "a.listing-item",
      (links) => links.map((link) => (link as HTMLAnchorElement).href)
    );

    jobLogger.info(`Found ${listingLinks.length} listings`);

    for (const link of listingLinks.slice(0, 20)) {
      try {
        await page.goto(link, { waitUntil: "networkidle0", timeout: config.browser.timeout });
        await delay(config.rateLimit.delayMs);

        const title = await page.$eval("h1", (el) => el.textContent?.trim() || "").catch(() => "");
        const priceText = await page.$eval(".price-value", (el) => el.textContent?.trim() || "").catch(() => "");
        const price = parseInt(priceText.replace(/[^0-9]/g, "") || "0", 10);

        const photos = await page.$$eval(".gallery img", (imgs) =>
          imgs.map((img) => (img as HTMLImageElement).src).filter((src) => src)
        );

        listings.push({
          source_id: "",
          url: link,
          title,
          price,
          type: "house",
          bedrooms: 0,
          bathrooms: 0,
          surface_sqm: 0,
          address: "",
          city: "",
          postal_code: "",
          province: "",
          latitude: 0,
          longitude: 0,
          photos: photos.slice(0, 10),
          description: "",
          energy_rating: "G",
          year_built: 0,
          agent_name: "",
          agent_phone: "",
          agent_agency: "",
          amenities: [],
        });
      } catch (err) {
        errors.push(`Failed: ${link} - ${err}`);
      }
    }
  } catch (err) {
    errors.push(`Scraper failed: ${err}`);
  }

  return { listings, errors };
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