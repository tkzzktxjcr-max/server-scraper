import { Page } from "puppeteer";
import { BaseScraper, ScraperFilters, JobLogger, SearchResultItem, ScrapeResult } from "./base.js";
import { InterceptedResponse } from "../browser/manager.js";
import { RawListing } from "../utils/validation.js";
import { cleanString, cleanNumber, cleanInt, cleanEnergyRating, cleanPhotos, normalizePropertyType } from "../utils/validation.js";
import { PropertyData } from "../appwrite/client.js";
import { logger } from "../utils/logger.js";

// ─────────────────────────────────────────────
// IMMOWEB SCRAPER
// ─────────────────────────────────────────────

export class ImmowebScraper extends BaseScraper {
  constructor(siteId: string, filters: ScraperFilters, jobLogger: JobLogger) {
    super("immoweb", siteId, filters, jobLogger);
  }

  protected getApiPattern(): string | RegExp {
    return /apigw\.immoweb\.be|immoweb\.be\/api|__NEXT_DATA__/;
  }

  protected buildSearchUrl(page: number): string {
    const params = new URLSearchParams();

    // Immoweb search URL structure
    let baseUrl = "https://www.immoweb.be/en/search";

    // Property type
    if (this.filters.type) {
      const typeMap: Record<string, string> = {
        apartment: "apartment",
        house: "house",
        villa: "house",
        studio: "studio",
        commercial: "commercial-property",
      };
      params.set("propertyType", typeMap[this.filters.type] || this.filters.type);
    }

    // Price range
    if (this.filters.price_min) {
      params.set("minPrice", this.filters.price_min.toString());
    }
    if (this.filters.price_max) {
      params.set("maxPrice", this.filters.price_max.toString());
    }

    // City / Location
    if (this.filters.city) {
      params.set("postalCode", this.filters.city);
    }

    // Bedrooms
    if (this.filters.bedrooms_min) {
      params.set("minBedrooms", this.filters.bedrooms_min.toString());
    }

    // Pagination
    params.set("page", page.toString());

    const queryString = params.toString();
    return queryString ? `${baseUrl}?${queryString}` : baseUrl;
  }

  protected async parseSearchResults(page: Page, apiResponses: InterceptedResponse[]): Promise<SearchResultItem[]> {
    const items: SearchResultItem[] = [];

    // ─────────────────────────────────────────────
    // STRATEGY 1: Try to extract from intercepted API responses
    // ─────────────────────────────────────────────

    for (const response of apiResponses) {
      try {
        const body = response.body as Record<string, unknown>;
        if (!body || typeof body !== "object") continue;

        // Immoweb API returns results in different formats
        const results = (body as Record<string, unknown>).results ||
                        (body as Record<string, unknown>).data ||
                        (body as Record<string, unknown>).items ||
                        (body as Record<string, unknown>).properties;

        if (Array.isArray(results)) {
          for (const item of results) {
            const parsed = this.parseApiListItem(item as Record<string, unknown>);
            if (parsed) items.push(parsed);
          }
        }
      } catch {
        // Continue to next response
      }
    }

    // ─────────────────────────────────────────────
    // STRATEGY 2: Try to extract from __NEXT_DATA__
    // ─────────────────────────────────────────────

    if (items.length === 0) {
      try {
        const nextData = await page.evaluate(() => {
          const el = document.getElementById("__NEXT_DATA__");
          if (el?.textContent) {
            try { return JSON.parse(el.textContent); } catch { return null; }
          }
          return null;
        });

        if (nextData?.props?.pageProps?.searchResults) {
          const results = nextData.props.pageProps.searchResults;
          if (Array.isArray(results)) {
            for (const item of results) {
              const parsed = this.parseApiListItem(item);
              if (parsed) items.push(parsed);
            }
          }
        }

        // Also check for listings in other __NEXT_DATA__ paths
        if (nextData?.props?.pageProps?.listings) {
          const listings = nextData.props.pageProps.listings;
          if (Array.isArray(listings)) {
            for (const item of listings) {
              const parsed = this.parseApiListItem(item);
              if (parsed) items.push(parsed);
            }
          }
        }
      } catch {
        // __NEXT_DATA__ not available
      }
    }

    // ─────────────────────────────────────────────
    // STRATEGY 3: Fallback to CSS selectors
    // ─────────────────────────────────────────────

    if (items.length === 0) {
      this.jobLogger.warn("API extraction failed, falling back to CSS selectors");

      try {
        const cssItems = await page.evaluate(() => {
          const cards = document.querySelectorAll('[class*="card--result"], [data-test="search-result-item"], article[class*="property"]');
          return Array.from(cards).map((card) => {
            const link = card.querySelector("a[href*='/en/classified']") as HTMLAnchorElement ||
                         card.querySelector("a[href*='/ad']") as HTMLAnchorElement ||
                         card.querySelector("a") as HTMLAnchorElement;
            if (!link) return null;

            const url = link.href;
            const sourceIdMatch = url.match(/(\d{6,})/);
            const source_id = sourceIdMatch ? sourceIdMatch[1] : "";

            const titleEl = card.querySelector('[class*="title"], h2, h3, [data-test="property-title"]');
            const priceEl = card.querySelector('[class*="price"], [data-test="price"]');
            const locEl = card.querySelector('[class*="location"], [class*="address"], [data-test="property-location"]');

            return {
              source_id,
              url,
              partial: {
                title: titleEl?.textContent?.trim() || "",
                price: parseInt(priceEl?.textContent?.replace(/[^\d]/g, "") || "0", 10),
                city: locEl?.textContent?.trim() || "",
              },
            };
          }).filter(Boolean);
        });

        for (const item of cssItems) {
          if (item) items.push(item as SearchResultItem);
        }
      } catch (error) {
        this.jobLogger.error("CSS fallback extraction failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Deduplicate by URL
    const seen = new Set<string>();
    const uniqueItems = items.filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });

    return uniqueItems;
  }

  protected async extractDetailData(
    page: Page,
    item: SearchResultItem,
    apiResponses: InterceptedResponse[]
  ): Promise<RawListing | null> {
    // ─────────────────────────────────────────────
    // STRATEGY 1: Extract from __NEXT_DATA__
    // ─────────────────────────────────────────────

    try {
      const nextData = await page.evaluate(() => {
        const el = document.getElementById("__NEXT_DATA__");
        if (el?.textContent) {
          try { return JSON.parse(el.textContent); } catch { return null; }
        }
        return null;
      });

      if (nextData?.props?.pageProps?.classified) {
        const classified = nextData.props.pageProps.classified;
        return this.parseClassifiedData(classified, item);
      }

      if (nextData?.props?.pageProps?.property) {
        const property = nextData.props.pageProps.property;
        return this.parseClassifiedData(property, item);
      }
    } catch {
      // __NEXT_DATA__ not available
    }

    // ─────────────────────────────────────────────
    // STRATEGY 2: Extract from intercepted API responses
    // ─────────────────────────────────────────────

    for (const response of apiResponses) {
      try {
        const body = response.body as Record<string, unknown>;
        if (body?.classified || body?.property || body?.data) {
          const data = (body.classified || body.property || body.data) as Record<string, unknown>;
          return this.parseClassifiedData(data, item);
        }
      } catch {
        // continue
      }
    }

    // ─────────────────────────────────────────────
    // STRATEGY 3: Fallback to CSS extraction
    // ─────────────────────────────────────────────

    return this.extractDetailFromCSS(page, item);
  }

  // ─────────────────────────────────────────────
  // PARSERS
  // ─────────────────────────────────────────────

  private parseApiListItem(item: Record<string, unknown>): SearchResultItem | null {
    try {
      // Extract source_id
      const source_id = cleanString(item.id || item.sourceId || item.propertyId || item.classifiedId || "");
      if (!source_id) return null;

      // Extract URL
      let url = cleanString(item.url || item.link || item.detailUrl || "");
      if (!url) {
        // Build URL from ID
        url = `https://www.immoweb.be/en/classified/${source_id}`;
      }
      if (!url.startsWith("http")) {
        url = `https://www.immoweb.be${url.startsWith("/") ? "" : "/"}${url}`;
      }

      // Extract partial data from search results
      const partial: Partial<RawListing> = {
        title: cleanString(item.title || item.name || ""),
        price: cleanNumber(item.price || 0),
        type: normalizePropertyType(cleanString(item.type || item.propertyType || "")),
        city: cleanString(item.city || item.locality || ""),
        postal_code: cleanString(item.postalCode || item.zip || ""),
        bedrooms: cleanInt(item.bedrooms || item.bedroomCount || 0),
        surface_sqm: cleanNumber(item.surface || item.livingArea || item.area || 0),
        photos: cleanPhotos(item.images || item.photos || item.pictures || []),
      };

      return { source_id, url, partial };
    } catch {
      return null;
    }
  }

  private parseClassifiedData(data: Record<string, unknown>, item: SearchResultItem): RawListing | null {
    try {
      // Navigate nested structures
      const property = (data.property as Record<string, unknown>) || data;
      const location = (data.location as Record<string, unknown>) || (property.location as Record<string, unknown>) || {};
      const price = (data.price as Record<string, unknown>) || (property.price as Record<string, unknown>) || {};
      const attributes = (data.attributes as Record<string, unknown>) || (property.attributes as Record<string, unknown>) || {};
      const agency = (data.agency as Record<string, unknown>) || (property.agency as Record<string, unknown>) || {};
      const energy = (data.energy as Record<string, unknown>) || (property.energy as Record<string, unknown>) || {};

      // Extract source_id
      const source_id = cleanString(data.id || data.classifiedId || data.sourceId || item.source_id);

      // Extract URL
      const url = cleanString(data.url || item.url);

      // Extract title
      const title = cleanString(data.title || data.name || property.title || item.partial?.title || "");

      // Extract price
      const priceValue = cleanNumber(price.mainValue || price.value || data.price || item.partial?.price || 0);

      // Extract type
      const rawType = cleanString(property.type || data.type || attributes.propertyType || "");
      const type = rawType ? normalizePropertyType(rawType) : (item.partial?.type || "house");

      // Extract location
      const city = cleanString(location.locality || location.city || location.town || item.partial?.city || "");
      const postal_code = cleanString(location.postalCode || location.zipcode || location.zip || "");
      const province = cleanString(location.province || location.region || "");
      const address = cleanString(location.street || location.address || location.fullAddress || "");
      const latitude = cleanNumber(location.latitude || location.lat || 0);
      const longitude = cleanNumber(location.longitude || location.lng || location.lon || 0);

      // Extract specs
      const bedrooms = cleanInt(attributes.bedroomCount || property.bedrooms || data.bedrooms || item.partial?.bedrooms || 0);
      const bathrooms = cleanInt(attributes.bathroomCount || property.bathrooms || data.bathrooms || 0);
      const surface_sqm = cleanNumber(attributes.livingArea || property.surface || data.surface || item.partial?.surface_sqm || 0);

      // Extract photos
      const photos = cleanPhotos(data.images || property.images || data.photos || item.partial?.photos || []);

      // Extract description
      const description = cleanString(data.description || property.description || "");

      // Extract energy rating
      const energy_rating = cleanEnergyRating(energy.rating || energy.class || data.energyRating || "");

      // Extract year built
      const yearBuiltRaw = cleanInt(attributes.yearBuilt || property.yearBuilt || data.yearBuilt || 0);
      const year_built = yearBuiltRaw > 1800 ? yearBuiltRaw : null;

      // Extract agent info
      const agent_name = cleanString(agency.name || data.agentName || "");
      const agent_phone = cleanString(agency.phone || agency.telephone || data.agentPhone || "");
      const agent_agency = cleanString(agency.companyName || agency.agencyName || data.agentAgency || "");

      // Extract amenities
      const amenities: string[] = [];
      if (attributes.hasGarden || data.garden) amenities.push("Garden");
      if (attributes.hasTerrace || data.terrace) amenities.push("Terrace");
      if (attributes.hasParking || data.parking) amenities.push("Parking");
      if (attributes.hasGarage || data.garage) amenities.push("Garage");
      if (attributes.hasSwimmingPool || data.swimmingPool) amenities.push("Swimming Pool");
      if (attributes.hasElevator || data.elevator) amenities.push("Elevator");

      // Also check for amenities array
      if (Array.isArray(data.amenities) || Array.isArray(attributes.amenities)) {
        const rawAmenities = (data.amenities || attributes.amenities) as unknown[];
        for (const a of rawAmenities) {
          const label = cleanString(typeof a === "string" ? a : (a as Record<string, unknown>).name || (a as Record<string, unknown>).label || "");
          if (label && !amenities.includes(label)) amenities.push(label);
        }
      }

      return {
        source_id: source_id || item.source_id,
        url: url || item.url,
        title: title || "Untitled",
        price: priceValue,
        type: type || "house",
        city,
        postal_code,
        province,
        bedrooms,
        bathrooms,
        surface_sqm,
        latitude,
        longitude,
        address,
        photos,
        description,
        energy_rating,
        year_built,
        agent_name,
        agent_phone,
        agent_agency,
        amenities,
      };
    } catch (error) {
      this.jobLogger.error("Failed to parse classified data", {
        error: error instanceof Error ? error.message : String(error),
        sourceId: item.source_id,
      });
      return null;
    }
  }

  private async extractDetailFromCSS(page: Page, item: SearchResultItem): Promise<RawListing | null> {
    try {
      const data = await page.evaluate(() => {
        // Title
        const title = document.querySelector("h1")?.textContent?.trim() || "";

        // Price
        const priceText = document.querySelector('[class*="price"], [data-test="price"]')?.textContent || "";
        const price = parseInt(priceText.replace(/[^\d]/g, "") || "0", 10);

        // Location
        const locEl = document.querySelector('[class*="location"], [class*="address"]');
        const city = locEl?.textContent?.trim() || "";

        // Specs from property table
        const specs: Record<string, string> = {};
        document.querySelectorAll("dt, th, [class*='label']").forEach((el) => {
          const key = el.textContent?.trim().toLowerCase() || "";
          const value = el.nextElementSibling?.textContent?.trim() || "";
          if (key && value) specs[key] = value;
        });

        // Bedrooms
        const bedroomsMatch = Object.entries(specs).find(([k]) => k.includes("bedroom"));
        const bedrooms = bedroomsMatch ? parseInt(bedroomsMatch[1]) || 0 : 0;

        // Bathrooms
        const bathroomsMatch = Object.entries(specs).find(([k]) => k.includes("bathroom"));
        const bathrooms = bathroomsMatch ? parseInt(bathroomsMatch[1]) || 0 : 0;

        // Surface
        const surfaceMatch = Object.entries(specs).find(([k]) => k.includes("surface") || k.includes("area") || k.includes("living"));
        const surface = surfaceMatch ? parseInt(surfaceMatch[1]) || 0 : 0;

        // Energy
        const energyMatch = Object.entries(specs).find(([k]) => k.includes("energy") || k.includes("epc"));
        const energy = energyMatch ? energyMatch[1].charAt(0).toUpperCase() : "";

        // Year built
        const yearMatch = Object.entries(specs).find(([k]) => k.includes("year") || k.includes("built") || k.includes("construction"));
        const yearBuilt = yearMatch ? parseInt(yearMatch[1]) || 0 : 0;

        // Photos
        const photos: string[] = [];
        document.querySelectorAll('[class*="gallery"] img, [class*="carousel"] img, [data-test="property-image"] img').forEach((img) => {
          const src = (img as HTMLImageElement).src;
          if (src && !src.includes("placeholder") && !src.includes("logo")) photos.push(src);
        });

        // Description
        const description = document.querySelector('[class*="description"], [class*="about"]')?.textContent?.trim() || "";

        // Agent
        const agentName = document.querySelector('[class*="agent"] [class*="name"], [data-test="agent-name"]')?.textContent?.trim() || "";
        const agentPhone = document.querySelector('[class*="agent"] [class*="phone"], [data-test="agent-phone"]')?.textContent?.trim() || "";
        const agentAgency = document.querySelector('[class*="agent"] [class*="agency"], [data-test="agency-name"]')?.textContent?.trim() || "";

        return {
          title, price, city, bedrooms, bathrooms, surface, energy, yearBuilt,
          photos, description, agentName, agentPhone, agentAgency,
        };
      });

      return {
        source_id: item.source_id,
        url: item.url,
        title: data.title || item.partial?.title || "Untitled",
        price: data.price || item.partial?.price || 0,
        type: item.partial?.type || "house",
        city: data.city || item.partial?.city || "",
        postal_code: item.partial?.postal_code || "",
        province: "",
        bedrooms: data.bedrooms || item.partial?.bedrooms || 0,
        bathrooms: data.bathrooms || 0,
        surface_sqm: data.surface || item.partial?.surface_sqm || 0,
        latitude: 0,
        longitude: 0,
        address: "",
        photos: data.photos || item.partial?.photos || [],
        description: data.description,
        energy_rating: data.energy,
        year_built: data.yearBuilt > 1800 ? data.yearBuilt : null,
        agent_name: data.agentName,
        agent_phone: data.agentPhone,
        agent_agency: data.agentAgency,
        amenities: [],
      };
    } catch (error) {
      this.jobLogger.error("CSS detail extraction failed", {
        error: error instanceof Error ? error.message : String(error),
        url: item.url,
      });
      return null;
    }
  }
}

// ─────────────────────────────────────────────
// LEGACY EXPORTS (for backward compatibility)
// ─────────────────────────────────────────────

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
  year_built: number | null;
  agent_name: string;
  agent_phone: string;
  agent_agency: string;
  amenities: string[];
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
    year_built: listing.year_built || 0,
  };
}