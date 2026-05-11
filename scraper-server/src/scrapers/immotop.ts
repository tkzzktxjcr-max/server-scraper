/**
 * Immotop.be HTTP-only scraper with cheerio parsing.
 * Accessible from cloud IPs without proxy.
 */
import * as cheerio from "cheerio";
import { ScraperFilters, JobLogger, SearchResultItem } from "./base.js";
import { PropertyData } from "../appwrite/client.js";

export class ImmotopScraper {
  private logger: JobLogger;
  private baseUrl = "https://www.immotop.be";

  constructor(logger: JobLogger) {
    this.logger = logger;
  }

  buildSearchUrl(filters?: ScraperFilters): string {
    let url = `${this.baseUrl}/te-koop`;
    const params = new URLSearchParams();
    if (filters?.city) params.set("location", filters.city);
    if (filters?.price_min) params.set("minPrice", String(filters.price_min));
    if (filters?.price_max) params.set("maxPrice", String(filters.price_max));
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  private async httpGet(url: string): Promise<string> {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "nl;q=0.9,en;q=0.8",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
    return res.text();
  }

  async extractListings(url: string): Promise<SearchResultItem[]> {
    this.logger.info(`Fetching: ${url}`);
    const html = await this.httpGet(url);
    const $ = cheerio.load(html);
    const listings: SearchResultItem[] = [];
    const seen = new Set<string>();

    // Look for listing links
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") || "";
      if (!href.includes("detail") && !href.includes("annonce") && !href.includes("property")) return;
      if (seen.has(href)) return;
      seen.add(href);

      const fullUrl = href.startsWith("http") ? href : this.baseUrl + href;
      const container = $(el).closest("div, article, section, li");

      // Price
      let price = 0;
      container.find("*").each((_, child) => {
        const text = $(child).text().trim();
        const m = text.match(/(\d{3}[\.\s]?\d{3})\s*€/);
        if (m && !price) price = parseInt(m[1].replace(/[\s.]/g, ""), 10) || 0;
      });

      // Title
      const title = container.find("h2, h3, h4").first().text().trim()
        || $(el).find("img").attr("alt") || ""
        || $(el).text().trim().substring(0, 100);

      // City
      const city = container.find("[class*='city'], [class*='location'], [class*='gemeente']").text().trim();

      // Source ID from URL
      const idMatch = fullUrl.match(/(\d{4,})/);
      const source_id = idMatch ? idMatch[1] : fullUrl.split("/").pop() || "";

      if (source_id && (title || price > 0)) {
        listings.push({ source_id, url: fullUrl, title, price, city, type: "house" });
      }
    });

    this.logger.info(`Found ${listings.length} listings`);
    return listings;
  }

  async scrapeDetailPage(url: string): Promise<Partial<PropertyData>> {
    this.logger.info(`Fetching detail: ${url}`);
    const html = await this.httpGet(url);
    const $ = cheerio.load(html);
    const bodyText = $("body").text();

    // JSON-LD extraction
    let jsonLd: any = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (jsonLd) return;
      try {
        const data = JSON.parse($(el).html() || "");
        if (data["@type"] === "Residence" || data["@type"] === "RealEstateListing") jsonLd = data;
        if (data["@graph"]) {
          for (const item of data["@graph"]) {
            if (item["@type"] === "Residence") jsonLd = item;
          }
        }
      } catch {}
    });

    const result: Partial<PropertyData> = {};

    if (jsonLd) {
      result.title = jsonLd.name || "";
      result.description = jsonLd.description || "";
      const addr = jsonLd.address;
      if (addr && typeof addr === "object") {
        result.city = addr.addressLocality || "";
        result.postal_code = addr.postalCode || "";
        result.address = `${addr.streetAddress || ""}, ${addr.postalCode || ""} ${addr.addressLocality || ""}`;
      }
      result.bedrooms = jsonLd.numberOfBedrooms || 0;
      result.bathrooms = jsonLd.numberOfBathroomsTotal || 0;
      const floorSize = jsonLd.floorSize;
      if (floorSize && typeof floorSize === "object") result.surface_sqm = parseFloat(floorSize.value) || 0;
    }

    // Fallbacks
    if (!result.title) result.title = $("h1").first().text().trim() || $('meta[property="og:title"]').attr("content") || "";
    if (!result.description) result.description = $('meta[property="og:description"]').attr("content") || "";

    // Price
    let price = 0;
    $("*").each((_, el) => {
      if (price) return;
      const text = $(el).text().trim();
      const m = text.match(/(\d{3}[\.\s]?\d{3})\s*€/);
      if (m) price = parseInt(m[1].replace(/[\s.]/g, ""), 10) || 0;
    });
    result.price = price;

    // Surface/bedrooms from body
    if (!result.surface_sqm) {
      const m = bodyText.match(/(\d+(?:[.,]\d+)?)\s*m²/i);
      result.surface_sqm = m ? parseFloat(m[1].replace(",", ".")) : 0;
    }
    if (!result.bedrooms) {
      const m = bodyText.match(/(\d+)\s*(?:slaapkamer|bedroom|chambre)/i);
      result.bedrooms = m ? parseInt(m[1]) : 0;
    }

    // EPC
    const epcMatch = bodyText.match(/(?:EPC|energie)[:\s]*([A-G])/i);
    result.energy_rating = epcMatch ? epcMatch[1].toUpperCase() : "";

    // Photos
    const imgs: string[] = [];
    const ogImg = $('meta[property="og:image"]').attr("content");
    if (ogImg) imgs.push(ogImg);
    $("img").each((_, el) => {
      const src = $(el).attr("src") || "";
      if (src.startsWith("http") && !src.includes("logo") && !src.includes("icon")) imgs.push(src);
    });
    result.photos = [...new Set(imgs)];

    result.type = "house";
    return result;
  }
}