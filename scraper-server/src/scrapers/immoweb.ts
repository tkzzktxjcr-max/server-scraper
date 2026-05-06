import { Page } from "puppeteer-core";
import { BaseScraper, JobLogger, SearchResultItem } from "./base.js";
import { InterceptedResponse } from "../browser/manager.js";
import { RawListing } from "../utils/validation.js";
import { cleanString, cleanNumber, cleanInt, cleanEnergyRating, cleanPhotos, normalizePropertyType } from "../utils/validation.js";
import { PropertyData } from "../appwrite/client.js";

export class ImmowebScraper extends BaseScraper {
  constructor(logger: JobLogger) {
    super("immoweb", "https://www.immoweb.be", logger);
  }

  getApiPattern(): string | RegExp {
    return /immoweb\.be.*\/search/;
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
              url: item.url || `https://www.immoweb.be/en/classified/${item.id}`,
              title: item.title || item.property?.title || "",
              price: cleanNumber(item.price || item.transaction?.sale?.price || 0),
              city: cleanString(item.property?.location?.city || ""),
              type: normalizePropertyType(item.property?.type || ""),
              bedrooms: cleanInt(item.property?.bedroomCount || 0),
              surface_sqm: cleanNumber(item.property?.netHabitableSurface || 0),
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
    // Try to extract from API responses first
    for (const response of responses) {
      try {
        const body = response.body as any;
        if (body?.id || body?.property) {
          const prop = body.property || body;
          return {
            title: cleanString(body.title || prop.title || ""),
            description: cleanString(body.description || prop.description || ""),
            price: cleanNumber(body.price || body.transaction?.sale?.price || 0),
            surface_sqm: cleanNumber(prop.netHabitableSurface || 0),
            bedrooms: cleanInt(prop.bedroomCount || 0),
            bathrooms: cleanInt(prop.bathroomCount || 0),
            type: normalizePropertyType(prop.type || ""),
            city: cleanString(prop.location?.city || ""),
            postal_code: cleanString(prop.location?.postalCode || ""),
            province: cleanString(prop.location?.province || ""),
            latitude: cleanNumber(prop.location?.latitude || 0),
            longitude: cleanNumber(prop.location?.longitude || 0),
            address: cleanString(prop.location?.street || prop.location?.address || ""),
            photos: cleanPhotos(prop.media?.pictures?.map((p: any) => p.largeUrl || p.mediumUrl) || []),
            agent_name: cleanString(body.contact?.name || ""),
            agent_phone: cleanString(body.contact?.phone || ""),
            agent_agency: cleanString(body.contact?.companyName || ""),
            amenities: [],
            energy_rating: cleanEnergyRating(prop.certificates?.primaryEnergyConsumptionLevel || ""),
            year_built: cleanInt(prop.building?.constructionYear || 0) || null,
          };
        }
      } catch {
        // Continue to next response
      }
    }

    // Fallback: scrape from page DOM
    return {};
  }
}