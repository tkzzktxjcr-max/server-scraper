// @ts-nocheck
import { Page } from "puppeteer";
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
  filters = {},
  jobLogger: any
): Promise<{ listings: ImmowebListing[]; errors: string[] }> {
  const listings: ImmowebListing[] = [];
  const errors: string[] = [];

  try {
    let url = "https://www.immoweb.be/en/search";
    
    jobLogger.info(`Navigating to: ${url}`);
    await page.goto(url, { waitUntil: "networkidle0", timeout: config.browser.timeout });
    await delay(2000);

    let previousHeight = 0;
    for (let i = 0; i < 5; i++) {
      const currentHeight = await page.evaluate("document.body.scrollHeight");
      if (currentHeight === previousHeight) break;
      await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
      await delay(1500);
      previousHeight = currentHeight;
    }

    const listingLinks = await page.$$eval(
      "a.search-results__item a.card__title-link",
      (links) => links.map((link) => (link as HTMLAnchorElement).href)
    );

    jobLogger.info(`Found ${listingLinks.length} listings`);

    for (const link of listingLinks) {
      try {
        await page.goto(link, { waitUntil: "networkidle0", timeout: config.browser.timeout });
        await delay(config.rateLimit.delayMs);

        const title = await page.$eval("h1.property-title", (el) => el.textContent?.trim() || "").catch(() => "");
        const priceText = await page.$eval(".price", (el) => el.textContent?.trim() || "").catch(() => "");
        const price = parseInt(priceText.replace(/[^0-9]/g, "") || "0", 10);

        const photos = await page.$$eval(".property-gallery img", (imgs) =>
          imgs.map((img) => (img as HTMLImageElement).src).filter((src) => src && !src.includes("placeholder"))
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