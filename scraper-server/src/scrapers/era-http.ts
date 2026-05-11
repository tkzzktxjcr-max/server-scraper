/**
 * ERA HTTP-only scraper — robust parsing with cheerio + JSON-LD.
 * No Playwright needed. Works from any IP (cloud included).
 */
import * as cheerio from "cheerio";
import { ScraperFilters, JobLogger, SearchResultItem } from "./base.js";
import { PropertyData } from "../appwrite/client.js";

export class EraHttpScraper {
  private logger: JobLogger;
  private baseUrl = "https://www.era.be";
  private sitemapUrl = "https://www.era.be/sitemap.xml";

  constructor(logger: JobLogger) {
    this.logger = logger;
  }

  private async httpGet(url: string): Promise<string> {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "nl;q=0.9,en;q=0.8",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
    return res.text();
  }

  // ─── SITEMAP DISCOVERY ───

  async getSitemapPages(): Promise<string[]> {
    this.logger.info("Fetching ERA sitemap index...");
    const xml = await this.httpGet(this.sitemapUrl);
    const urls: string[] = [];
    for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      if (match[1].includes("sitemap.xml?page=")) urls.push(match[1]);
    }
    this.logger.info(`Found ${urls.length} sitemap pages`);
    return urls;
  }

  async getCityUrls(sitemapPageUrl: string): Promise<string[]> {
    const xml = await this.httpGet(sitemapPageUrl);
    const urls: string[] = [];
    for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      if (match[1].includes("/te-koop/")) urls.push(match[1]);
    }
    return urls;
  }

  // ─── CITY PAGE SCRAPING (cheerio) ───

  async scrapeCityPage(url: string): Promise<SearchResultItem[]> {
    this.logger.info(`Fetching city: ${url}`);
    const html = await this.httpGet(url);
    const $ = cheerio.load(html);
    const listings: SearchResultItem[] = [];
    const seen = new Set<string>();

    // Strategy: iterate over article.node--property containers first
    $("article.node--property").each((_, article) => {
      // Link to detail page
      const linkEl = $(article).find("a[href*='/te-koop/']").first();
      const href = linkEl.attr("href") || "";
      const parts = href.split("/").filter(Boolean);
      if (parts.length < 5) return;

      const fullUrl = href.startsWith("http") ? href : this.baseUrl + href;
      if (seen.has(fullUrl)) return;
      seen.add(fullUrl);

      // City & type from URL
      const city = parts[2] ? this.capitalize(parts[2].replace(/-/g, " ")) : "";
      const type = this.normalizeType(parts[3] || "house");

      // Price: div.field--price inside this article
      let price = 0;
      const priceEl = $(article).find("div.field--price").first();
      if (priceEl.length) {
        const priceText = priceEl.text().trim();
        const m = priceText.match(/([\d\s.]+)/);
        if (m) price = parseInt(m[1].replace(/[\s.]/g, ""), 10) || 0;
      }

      // Title: from image alt or heading
      const title = $(article).find("img").first().attr("alt") || ""
        || $(article).find("h2, h3").first().text().trim()
        || parts[4]?.replace(/-/g, " ") || "";

      // Source ID: last URL segment
      const source_id = parts[parts.length - 1] || "";

      if (source_id && (title || price > 0)) {
        listings.push({ source_id, url: fullUrl, title, price, city, type });
      }
    });

    this.logger.info(`Scraped ${listings.length} listings from ${url}`);
    return listings;
  }

  // ─── DETAIL PAGE SCRAPING (JSON-LD + cheerio) ───

  async scrapeDetailPage(url: string): Promise<Partial<PropertyData>> {
    this.logger.info(`Fetching detail: ${url}`);
    const html = await this.httpGet(url);
    const $ = cheerio.load(html);

    // ── 1. Extract JSON-LD (most reliable) ──
    let jsonLd: any = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (jsonLd) return;
      try {
        const data = JSON.parse($(el).html() || "");
        if (data["@type"] === "Residence") jsonLd = data;
        // Handle @graph arrays
        if (data["@graph"]) {
          for (const item of data["@graph"]) {
            if (item["@type"] === "Residence" || item.headline) jsonLd = item;
          }
        }
      } catch {}
    });

    // ── 2. Build result from JSON-LD ──
    const result: Partial<PropertyData> = {};

    if (jsonLd) {
      result.title = jsonLd.name || jsonLd.headline || "";
      result.description = jsonLd.description || $('meta[property="og:description"]').attr("content") || "";

      // Address from JSON-LD
      const addr = jsonLd.address;
      if (addr && typeof addr === "object") {
        result.address = `${addr.streetAddress || ""}, ${addr.postalCode || ""} ${addr.addressLocality || ""}`;
        result.city = addr.addressLocality || "";
        result.postal_code = addr.postalCode || "";
      }

      // Bedrooms/bathrooms
      result.bedrooms = jsonLd.numberOfBedrooms || 0;
      result.bathrooms = jsonLd.numberOfBathroomsTotal || 0;

      // Surface
      const floorSize = jsonLd.floorSize;
      if (floorSize && typeof floorSize === "object") {
        result.surface_sqm = parseFloat(floorSize.value) || 0;
      }
    }

    // ── 3. Fallbacks from meta/DOM ──
    if (!result.title) result.title = $("h1").first().text().trim() || $('meta[property="og:title"]').attr("content") || "";
    if (!result.description) result.description = $('meta[property="og:description"]').attr("content") || "";
    if (!result.city) result.city = $("address, [class*='address']").first().text().trim();

    // Price
    result.price = this.extractPrice($);

    // Surface from body text (fallback)
    if (!result.surface_sqm) {
      const bodyText = $("body").text();
      const surfaceMatch = bodyText.match(/(\d+(?:[.,]\d+)?)\s*m²/i);
      result.surface_sqm = surfaceMatch ? parseFloat(surfaceMatch[1].replace(",", ".")) : 0;
    }

    // Bedrooms/bathrooms from body (fallback)
    if (!result.bedrooms) {
      const bodyText = $("body").text();
      const bedMatch = bodyText.match(/(\d+)\s*slaapkamer/i);
      result.bedrooms = bedMatch ? parseInt(bedMatch[1]) : 0;
    }
    if (!result.bathrooms) {
      const bodyText = $("body").text();
      const bathMatch = bodyText.match(/(\d+)\s*badkamer/i);
      result.bathrooms = bathMatch ? parseInt(bathMatch[1]) : 0;
    }

    // EPC rating
    const bodyText = $("body").text();
    const epcMatch = bodyText.match(/(?:EPC|energieklasse|score)[:\s]*([A-G])/i);
    result.energy_rating = epcMatch ? epcMatch[1].toUpperCase() : "";

    // Type from URL
    const urlParts = url.split("/").filter(Boolean);
    const typePart = urlParts[urlParts.length - 2] || "house";
    result.type = this.normalizeType(typePart);

    // Photos
    result.photos = this.extractImages($);

    return result;
  }

  // ─── MAIN ENTRY ───

  async run(filters?: ScraperFilters): Promise<{
    listings: SearchResultItem[];
    totalFound: number;
  }> {
    const allListings: SearchResultItem[] = [];
    const seenIds = new Set<string>();

    const sitemapPages = await this.getSitemapPages();
    const maxSitemaps = Math.min(sitemapPages.length, 3);

    for (const sitemapPage of sitemapPages.slice(0, maxSitemaps)) {
      const cityUrls = await this.getCityUrls(sitemapPage);
      this.logger.info(`Sitemap ${sitemapPage}: ${cityUrls.length} cities`);

      const filteredCities = filters?.city
        ? cityUrls.filter((u) => u.toLowerCase().includes(filters.city!.toLowerCase()))
        : cityUrls;

      const maxCities = 10;
      for (const cityUrl of filteredCities.slice(0, maxCities)) {
        try {
          await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));
          const listings = await this.scrapeCityPage(cityUrl);
          for (const l of listings) {
            if (!seenIds.has(l.source_id)) {
              seenIds.add(l.source_id);
              allListings.push(l);
            }
          }
        } catch (e) {
          this.logger.warn(`Failed city ${cityUrl}`, { error: e instanceof Error ? e.message : String(e) });
        }
      }
    }

    return { listings: allListings, totalFound: allListings.length };
  }

  // ─── HELPERS ───

  private extractPrice($: cheerio.CheerioAPI): number {
    let price = 0;
    $("*").each((_, el) => {
      if (price) return;
      const text = $(el).text().trim();
      const m = text.match(/^€\s*([\d\s.]+)$/);
      if (m) price = parseInt(m[1].replace(/[\s.]/g, ""), 10) || 0;
    });
    if (!price) {
      const content = $('meta[property="product:price:amount"]').attr("content");
      if (content) price = parseInt(content.replace(/[^\d]/g, ""), 10) || 0;
    }
    return price;
  }

  private extractImages($: cheerio.CheerioAPI): string[] {
    const imgs: string[] = [];
    // OG image first
    const ogImg = $('meta[property="og:image"]').attr("content");
    if (ogImg) imgs.push(ogImg);
    // Then gallery images
    $("img").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src") || "";
      if (src.includes("era.be") && (src.includes("property") || src.includes("styles")) && !src.includes("logo") && !src.includes("mapbox")) {
        imgs.push(src);
      }
    });
    return [...new Set(imgs)].filter((u) => u.startsWith("http"));
  }

  private capitalize(str: string): string {
    return str.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }

  private normalizeType(raw: string): string {
    const lower = raw.toLowerCase();
    if (lower.includes("appartement") || lower.includes("apartment") || lower.includes("flat")) return "apartment";
    if (lower.includes("villa")) return "villa";
    if (lower.includes("studio")) return "studio";
    if (lower.includes("handel") || lower.includes("commercial") || lower.includes("bureau")) return "commercial";
    if (lower.includes("huis") || lower.includes("woning") || lower.includes("house") || lower.includes("maison")) return "house";
    return "house";
  }
}