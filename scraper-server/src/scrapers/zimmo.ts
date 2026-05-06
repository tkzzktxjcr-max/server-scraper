import { Page } from "puppeteer";
import { BaseScraper, ScraperFilters, JobLogger, SearchResultItem } from "./base.js";
import { InterceptedResponse } from "../browser/manager.js";
import { RawListing } from "../utils/validation.js";
import { cleanString, cleanNumber, cleanInt, cleanEnergyRating, cleanPhotos, normalizePropertyType } from "../utils/validation.js";
import { PropertyData } from "../appwrite/client.js";

// ─────────────────────────────────────────────
// ZIMMO SCRAPER
// ─────────────────────────────────────────────

export class ZimmoScraper extends BaseScraper {
  constructor(siteId: string, filters: ScraperFilters, jobLogger: JobLogger) {
    super("zimmo", siteId, filters, jobLogger);
  }

  protected getApiPattern(): string | RegExp {
    return /zimmo\.be\/api|api\.zimmo\.be|zimmo\.be\/search\/api/;
  }

  protected buildSearchUrl(page: number): string {
    let baseUrl = "https://www.zimmo.be/en/search/";

    const params = new URLSearchParams();

    // Property type
    if (this.filters.type) {
      const typeMap: Record<string, string> = {
        apartment: "apartment",
        house: "house",
        villa: "villa",
        studio: "studio",
        commercial: "commercial-property",
      };
      params.set("type", typeMap[this.filters.type] || this.filters.type);
    }

    // Price range
    if (this.filters.price_min) {
      params.set("minPrice", this.filters.price_min.toString());
    }
    if (this.filters.price_max) {
      params.set("maxPrice", this.filters.price_max.toString());
    }

    // City
    if (this.filters.city) {
      params.set("location", this.filters.city);
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
    // STRATEGY 1: Intercepted API responses
    // ─────────────────────────────────────────────

    for (const response of apiResponses) {
      try {
        const body = response.body as Record<string, unknown>;
        if (!body || typeof body !== "object") continue;

        const results = body.results || body.data || body.items || body.properties || body.listings;
        if (Array.isArray(results)) {
          for (const item of results) {
            const parsed = this.parseApiListItem(item as Record<string, unknown>);
            if (parsed) items.push(parsed);
          }
        }
      } catch {
        // continue
      }
    }

    // ─────────────────────────────────────────────
    // STRATEGY 2: Extract from embedded JSON
    // ─────────────────────────────────────────────

    if (items.length === 0) {
      try {
        const embeddedData = await page.evaluate(() => {
          // Check for __NUXT__ or similar data
          const nuxtEl = document.getElementById("__NUXT_DATA__");
          if (nuxtEl?.textContent) {
            try { return JSON.parse(nuxtEl.textContent); } catch { /* skip */ }
          }

          // Check for script tags with JSON data
          const scripts = document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]');
          for (const script of scripts) {
            try {
              const data = JSON.parse(script.textContent || "");
              if (data["@type"] === "ItemList" && Array.isArray(data.itemListElement)) {
                return data.itemListElement;
              }
              if (Array.isArray(data.results || data.properties || data.listings)) {
                return data.results || data.properties || data.listings;
              }
            } catch {
              // continue
            }
          }
          return null;
        });

        if (Array.isArray(embeddedData)) {
          for (const item of embeddedData) {
            const parsed = this.parseApiListItem(item as Record<string, unknown>);
            if (parsed) items.push(parsed);
          }
        }
      } catch {
        // No embedded data
      }
    }

    // ─────────────────────────────────────────────
    // STRATEGY 3: CSS fallback
    // ─────────────────────────────────────────────

    if (items.length === 0) {
      this.jobLogger.warn("API extraction failed, falling back to CSS selectors");

      try {
        const cssItems = await page.evaluate(() => {
          const links = document.querySelectorAll('a[href*="/property/"], a[href*="/listing/"]');
          const uniqueLinks = [...new Set(Array.from(links).map((l) => (l as HTMLAnchorElement).href))];

          return uniqueLinks.map((url) => {
            const sourceIdMatch = url.match(/(\d{5,})/);
            const source_id = sourceIdMatch ? sourceIdMatch[1] : "";

            // Try to find the card element for this link
            const card = document.querySelector(`a[href="${url}"]`)?.closest('[class*="card"], [class*="result"], [class*="item"]');
            const titleEl = card?.querySelector("h2, h3, [class*='title']");
            const priceEl = card?.querySelector("[class*='price'], [data-test='price']");
            const locEl = card?.querySelector("[class*='location'], [class*='city']");

            return {
              source_id,
              url,
              partial: {
                title: titleEl?.textContent?.trim() || "",
                price: parseInt(priceEl?.textContent?.replace(/[^\d]/g, "") || "0", 10),
                city: locEl?.textContent?.trim() || "",
              },
            };
          });
        });

        for (const item of cssItems) {
          if (item && item.url) items.push(item as SearchResultItem);
        }
      } catch (error) {
        this.jobLogger.error("CSS fallback extraction failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Deduplicate
    const seen = new Set<string>();
    return items.filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });
  }

  protected async extractDetailData(
    page: Page,
    item: SearchResultItem,
    apiResponses: InterceptedResponse[]
  ): Promise<RawListing | null> {
    // ─────────────────────────────────────────────
    // STRATEGY 1: Intercepted API responses
    // ─────────────────────────────────────────────

    for (const response of apiResponses) {
      try {
        const body = response.body as Record<string, unknown>;
        if (body?.property || body?.data || body?.detail) {
          const data = (body.property || body.data || body.detail) as Record<string, unknown>;
          return this.parseDetailData(data, item);
        }
      } catch {
        // continue
      }
    }

    // ─────────────────────────────────────────────
    // STRATEGY 2: JSON-LD
    // ─────────────────────────────────────────────

    try {
      const jsonLd = await page.evaluate(() => {
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of scripts) {
          try {
            const data = JSON.parse(script.textContent || "");
            if (data["@type"] === "Product" || data["@type"] === "RealEstateListing" || data.name) {
              return data;
            }
          } catch {
            // continue
          }
        }
        return null;
      });

      if (jsonLd) {
        return this.parseJsonLdData(jsonLd as Record<string, unknown>, item);
      }
    } catch {
      // No JSON-LD
    }

    // ─────────────────────────────────────────────
    // STRATEGY 3: CSS fallback
    // ─────────────────────────────────────────────

    return this.extractDetailFromCSS(page, item);
  }

  // ─────────────────────────────────────────────
  // PARSERS
  // ─────────────────────────────────────────────

  private parseApiListItem(item: Record<string, unknown>): SearchResultItem | null {
    try {
      const source_id = cleanString(item.id || item.propertyId || item.zimmoId || item.reference || "");
      if (!source_id) return null;

      let url = cleanString(item.url || item.link || item.detailUrl || "");
      if (!url) {
        url = `https://www.zimmo.be/en/property/${source_id}`;
      }
      if (!url.startsWith("http")) {
        url = `https://www.zimmo.be${url.startsWith("/") ? "" : "/"}${url}`;
      }

      const partial: Partial<RawListing> = {
        title: cleanString(item.title || item.name || ""),
        price: cleanNumber(item.price || 0),
        type: normalizePropertyType(cleanString(item.type || item.propertyType || "")),
        city: cleanString(item.city || item.locality || ""),
        postal_code: cleanString(item.postalCode || item.zip || ""),
        bedrooms: cleanInt(item.bedrooms || item.bedroomCount || 0),
        surface_sqm: cleanNumber(item.surface || item.livingArea || 0),
        photos: cleanPhotos(item.images || item.photos || []),
      };

      return { source_id, url, partial };
    } catch {
      return null;
    }
  }

  private parseDetailData(data: Record<string, unknown>, item: SearchResultItem): RawListing | null {
    try {
      const property = (data.property as Record<string, unknown>) || data;
      const location = (data.location as Record<string, unknown>) || (property.location as Record<string, unknown>) || {};
      const price = (data.price as Record<string, unknown>) || (property.price as Record<string, unknown>) || {};
      const features = (data.features as Record<string, unknown>) || (property.features as Record<string, unknown>) || {};
      const agency = (data.agency as Record<string, unknown>) || (property.agency as Record<string, unknown>) || {};

      const source_id = cleanString(data.id || data.zimmoId || data.reference || item.source_id);
      const url = cleanString(data.url || item.url);
      const title = cleanString(data.title || property.title || item.partial?.title || "");
      const priceValue = cleanNumber(price.amount || price.value || data.price || item.partial?.price || 0);
      const rawType = cleanString(property.type || data.type || data.propertyType || "");
      const type = rawType ? normalizePropertyType(rawType) : (item.partial?.type || "house");

      const city = cleanString(location.city || location.locality || item.partial?.city || "");
      const postal_code = cleanString(location.postalCode || location.zip || "");
      const province = cleanString(location.province || "");
      const address = cleanString(location.address || location.street || "");
      const latitude = cleanNumber(location.latitude || location.lat || 0);
      const longitude = cleanNumber(location.longitude || location.lng || 0);

      const bedrooms = cleanInt(features.bedrooms || property.bedrooms || data.bedrooms || item.partial?.bedrooms || 0);
      const bathrooms = cleanInt(features.bathrooms || property.bathrooms || data.bathrooms || 0);
      const surface_sqm = cleanNumber(features.livingArea || property.surface || data.surface || item.partial?.surface_sqm || 0);

      const photos = cleanPhotos(data.images || property.images || data.photos || item.partial?.photos || []);
      const description = cleanString(data.description || property.description || "");
      const energy_rating = cleanEnergyRating(features.energyClass || data.energyRating || "");
      const yearBuiltRaw = cleanInt(features.yearBuilt || property.yearBuilt || data.yearBuilt || 0);
      const year_built = yearBuiltRaw > 1800 ? yearBuiltRaw : null;

      const agent_name = cleanString(agency.name || data.agentName || "");
      const agent_phone = cleanString(agency.phone || data.agentPhone || "");
      const agent_agency = cleanString(agency.name || data.agencyName || "");

      const amenities: string[] = [];
      if (features.hasGarden || data.garden) amenities.push("Garden");
      if (features.hasTerrace || data.terrace) amenities.push("Terrace");
      if (features.hasParking || data.parking) amenities.push("Parking");
      if (features.hasGarage || data.garage) amenities.push("Garage");
      if (Array.isArray(data.amenities || features.amenities)) {
        for (const a of (data.amenities || features.amenities) as unknown[]) {
          const label = cleanString(typeof a === "string" ? a : (a as Record<string, unknown>).name || "");
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
      this.jobLogger.error("Failed to parse Zimmo detail data", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private parseJsonLdData(data: Record<string, unknown>, item: SearchResultItem): RawListing | null {
    try {
      const title = cleanString(data.name || item.partial?.title || "");
      const description = cleanString(data.description || "");
      const priceValue = cleanNumber((data.offers as Record<string, unknown>)?.price || data.price || item.partial?.price || 0);
      const photos = cleanPhotos(data.image || item.partial?.photos || []);
      const address = cleanString((data.address as Record<string, unknown>)?.streetAddress || "");
      const city = cleanString((data.address as Record<string, unknown>)?.addressLocality || item.partial?.city || "");
      const postal_code = cleanString((data.address as Record<string, unknown>)?.postalCode || "");

      return {
        source_id: item.source_id,
        url: item.url,
        title: title || "Untitled",
        price: priceValue,
        type: item.partial?.type || "house",
        city,
        postal_code,
        province: "",
        bedrooms: item.partial?.bedrooms || 0,
        bathrooms: 0,
        surface_sqm: item.partial?.surface_sqm || 0,
        latitude: 0,
        longitude: 0,
        address,
        photos,
        description,
        energy_rating: "",
        year_built: null,
        agent_name: "",
        agent_phone: "",
        agent_agency: "",
        amenities: [],
      };
    } catch {
      return null;
    }
  }

  private async extractDetailFromCSS(page: Page, item: SearchResultItem): Promise<RawListing | null> {
    try {
      const data = await page.evaluate(() => {
        const title = document.querySelector("h1")?.textContent?.trim() || "";
        const priceText = document.querySelector("[data-test='price'], [class*='price']")?.textContent || "";
        const price = parseInt(priceText.replace(/[€\s,]/g, "") || "0", 10);
        const locEl = document.querySelector("[class*='location'], [class*='address']");
        const city = locEl?.textContent?.trim() || "";

        const specs: Record<string, string> = {};
        document.querySelectorAll("dt, th, [class*='label'], [class*='feature']").forEach((el) => {
          const key = el.textContent?.trim().toLowerCase() || "";
          const value = el.nextElementSibling?.textContent?.trim() || "";
          if (key && value) specs[key] = value;
        });

        const bedroomsMatch = Object.entries(specs).find(([k]) => k.includes("bedroom"));
        const bathroomsMatch = Object.entries(specs).find(([k]) => k.includes("bathroom"));
        const surfaceMatch = Object.entries(specs).find(([k]) => k.includes("surface") || k.includes("area"));
        const energyMatch = Object.entries(specs).find(([k]) => k.includes("energy") || k.includes("epc"));
        const yearMatch = Object.entries(specs).find(([k]) => k.includes("year") || k.includes("built"));

        const photos: string[] = [];
        document.querySelectorAll("img[data-test='photo'], [class*='gallery'] img, [class*='carousel'] img").forEach((img) => {
          const src = (img as HTMLImageElement).src;
          if (src && !src.includes("placeholder")) photos.push(src);
        });

        const description = document.querySelector("[class*='description']")?.textContent?.trim() || "";
        const agentName = document.querySelector("[class*='agent'] [class*='name']")?.textContent?.trim() || "";
        const agentPhone = document.querySelector("[class*='agent'] [class*='phone']")?.textContent?.trim() || "";
        const agentAgency = document.querySelector("[class*='agency']")?.textContent?.trim() || "";

        return {
          title, price, city,
          bedrooms: bedroomsMatch ? parseInt(bedroomsMatch[1]) || 0 : 0,
          bathrooms: bathroomsMatch ? parseInt(bathroomsMatch[1]) || 0 : 0,
          surface: surfaceMatch ? parseInt(surfaceMatch[1]) || 0 : 0,
          energy: energyMatch ? energyMatch[1].charAt(0).toUpperCase() : "",
          yearBuilt: yearMatch ? parseInt(yearMatch[1]) || 0 : 0,
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
      this.jobLogger.error("Zimmo CSS detail extraction failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

// ─────────────────────────────────────────────
// LEGACY EXPORTS
// ─────────────────────────────────────────────

export interface ZimmoListing {
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

export function toPropertyData(listing: ZimmoListing, siteId: string): PropertyData {
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