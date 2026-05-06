import { Page } from "puppeteer-core";
import { BaseScraper, JobLogger, SearchResultItem } from "./base.js";
import { InterceptedResponse } from "../browser/manager.js";
import { RawListing } from "../utils/validation.js";
import { cleanString, cleanNumber, cleanInt, cleanEnergyRating, cleanPhotos, normalizePropertyType } from "../utils/validation.js";
import { PropertyData } from "../appwrite/client.js";

export class ImmovlanScraper extends BaseScraper {
  constructor(logger: JobLogger) {
    super("immovlan", "https://www.immovlan.be", logger);
  }

  getApiPattern(): string | RegExp {
    return /immovlan\.be.*\/search/;
  }

  parseSearchResults(responses: InterceptedResponse[]): SearchResultItem[] {
    const listings: SearchResultItem[] = [];
    
    for (const response of responses) {
      try {
        const body = response.body as any;
        if (body?.results?.length) {
          for (const item of body.results) {
            listings.push({
              source_id: String(item.id || ""),
              url: item.url || `https://www.immovlan.be/en/detail/${item.id}`,
              title: item.title || "",
              price: cleanNumber(item.price || 0),
              city: cleanString(item.city || ""),
              type: normalizePropertyType(item.type || ""),
              bedrooms: cleanInt(item.bedrooms || 0),
              surface_sqm: cleanNumber(item.surface || 0),
            });
          }
        }
      } catch {
        // Skip invalid responses
      }
    }
    
    return listings;
  }

  async extractDetailData(responses: InterceptedResponse[], url: string): Promise<Partial<PropertyData>> {
    for (const response of responses) {
      try {
        const body = response.body as any;
        if (body?.id || body?.property) {
          return {
            title: cleanString(body.title || ""),
            description: cleanString(body.description || ""),
            price: cleanNumber(body.price || 0),
            surface_sqm: cleanNumber(body.surface || 0),
            bedrooms: cleanInt(body.bedrooms || 0),
            bathrooms: cleanInt(body.bathrooms || 0),
            type: normalizePropertyType(body.type || ""),
            city: cleanString(body.city || ""),
            postal_code: cleanString(body.postalCode || ""),
            province: cleanString(body.province || ""),
            latitude: cleanNumber(body.latitude || 0),
            longitude: cleanNumber(body.longitude || 0),
            address: cleanString(body.address || ""),
            photos: cleanPhotos(body.photos || []),
            agent_name: cleanString(body.agent?.name || ""),
            agent_phone: cleanString(body.agent?.phone || ""),
            agent_agency: cleanString(body.agent?.agency || ""),
            amenities: [],
            energy_rating: cleanEnergyRating(body.energyRating || ""),
            year_built: cleanInt(body.yearBuilt || 0) || null,
          };
        }
      } catch {
        // Continue to next response
      }
    }

    return {};
  }
}