/**
 * Immovlan HTTP-only scraper with cheerio + sitemap discovery.
 * Accessible from cloud IPs. 13 sitemaps, ~30k property URLs.
 */
import * as cheerio from "cheerio";
import { ScraperFilters, JobLogger, SearchResultItem } from "./base.js";
import { PropertyData } from "../appwrite/client.js";

export class ImmovlanHttpScraper {
  private logger: JobLogger;
  private baseUrl = "https://immovlan.be";
  private sitemapIndexUrl = "https://immovlan.be/sitemap.xml";

  constructor(logger: JobLogger) {
    this.logger = logger;
  }

  private async httpGet(url: string): Promise<string> {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "nl;q=0.9,en;q=0.8,fr;q=0.7",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
    return res.text();
  }

  // ─── SITEMAP DISCOVERY ───

  async getPropertySitemaps(): Promise<string[]> {
    this.logger.info("Fetching Immovlan sitemap index...");
    const xml = await this.httpGet(this.sitemapIndexUrl);
    const urls: string[] = [];
    for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      if (match[1].includes("property-detail")) urls.push(match[1]);
    }
    this.logger.info(`Found ${urls.length} property sitemap pages`);
    return urls;
  }

  async getPropertyUrls(sitemapUrl: string, filters?: ScraperFilters): Promise<string[]> {
    const xml = await this.httpGet(sitemapUrl);
    const urls: string[] = [];
    for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const url = match[1];
      if (!url.includes("/te-koop/")) continue; // Only for-sale listings
      // Filter by city if specified
      if (filters?.city) {
        const lowerUrl = url.toLowerCase();
        const lowerCity = filters.city.toLowerCase().replace(/\s+/g, "-");
        if (!lowerUrl.includes(lowerCity)) continue;
      }
      urls.push(url);
    }
    return urls;
  }

  // ─── DETAIL PAGE SCRAPING ───

  async scrapeDetailPage(url: string): Promise<Partial<PropertyData> & { source_id: string }> {
    this.logger.info(`Fetching: ${url}`);
    const html = await this.httpGet(url);
    const $ = cheerio.load(html);

    // Extract structured data from the detail page
    const result: Partial<PropertyData> & { source_id: string } = {
      source_id: "",
    };

    // Source ID from URL: /rbv83425
    const idMatch = url.match(/(rbv\d+)$/i);
    result.source_id = idMatch ? idMatch[1] : url.split("/").pop() || "";

    // Title from <title> tag (very reliable on Immovlan)
    const pageTitle = $("title").text().trim();
    // Pattern: "Huis te koop in Street 123 City (RBV83425)"
    result.title = pageTitle.replace(/\(RBV\d+\)/, "").trim();

    // Type from URL: /nl/detail/{type}/te-koop/...
    const urlParts = url.split("/").filter(Boolean);
    const urlType = urlParts[3] || "huis";
    result.type = this.normalizeType(urlType);

    // City and postal code from URL: /nl/detail/{type}/te-koop/{postal}/{city}/...
    const teKoopIdx = urlParts.indexOf("te-koop");
    const postalCode = teKoopIdx >= 0 ? urlParts[teKoopIdx + 1] || "" : "";
    const citySlug = teKoopIdx >= 0 ? urlParts[teKoopIdx + 2] || "" : "";
    result.postal_code = postalCode;
    result.city = this.capitalize(citySlug.replace(/-/g, " "));

    // Price - look for price patterns
    let price = 0;
    $("*").each((_, el) => {
      if (price) return;
      const text = $(el).text().trim();
      const m = text.match(/^€\s*([\d\s.]+)$/);
      if (m) price = parseInt(m[1].replace(/[\s.]/g, ""), 10) || 0;
    });
    if (!price) {
      $("*").each((_, el) => {
        if (price) return;
        const text = $(el).text().trim();
        const m = text.match(/(\d{3}[\.\s]\d{3})\s*€/);
        if (m) price = parseInt(m[1].replace(/[\s.]/g, ""), 10) || 0;
      });
    }
    result.price = price;

    // Description
    result.description = $('meta[property="og:description"]').attr("content") || "";
    if (!result.description) {
      const descEl = $("[class*='description'], [class*='omschrijving']").first();
      result.description = descEl.text().trim().substring(0, 1000);
    }

    // Bedrooms, bathrooms, surface from text
    const bodyText = $("body").text();
    const bedMatch = bodyText.match(/(\d+)\s*(?:slaapkamer|bedroom|chambre)/i);
    result.bedrooms = bedMatch ? parseInt(bedMatch[1]) : 0;

    const bathMatch = bodyText.match(/(\d+)\s*(?:badkamer|bathroom|salle de bain)/i);
    result.bathrooms = bathMatch ? parseInt(bathMatch[1]) : 0;

    const surfaceMatch = bodyText.match(/(\d+(?:[.,]\d+)?)\s*m²/i);
    result.surface_sqm = surfaceMatch ? parseFloat(surfaceMatch[1].replace(",", ".")) : 0;

    // EPC
    const epcMatch = bodyText.match(/(?:EPC|energieklasse|score)[:\s]*([A-G])/i);
    result.energy_rating = epcMatch ? epcMatch[1].toUpperCase() : "";

    // Address
    result.address = `${result.city}, ${result.postal_code}`;

    // Photos
    const imgs: string[] = [];
    const ogImg = $('meta[property="og:image"]').attr("content");
    if (ogImg) imgs.push(ogImg);
    $("img").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src") || "";
      if (src.startsWith("http") && !src.includes("logo") && !src.includes("icon") && !src.includes("mapbox")) {
        imgs.push(src);
      }
    });
    result.photos = [...new Set(imgs)].slice(0, 10);

    return result;
  }

  // ─── MAIN ENTRY ───

  async run(filters?: ScraperFilters): Promise<{
    listings: SearchResultItem[];
    totalFound: number;
  }> {
    const allListings: SearchResultItem[] = [];
    const seenIds = new Set<string>();

    const sitemaps = await this.getPropertySitemaps();
    const maxSitemaps = Math.min(sitemaps.length, 3); // Limit for safety

    for (const sitemapUrl of sitemaps.slice(0, maxSitemaps)) {
      const urls = await this.getPropertyUrls(sitemapUrl, filters);
      this.logger.info(`Sitemap ${sitemapUrl}: ${urls.length} te-koop URLs`);

      const maxProperties = 10;
      for (const url of urls.slice(0, maxProperties)) {
        try {
          await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));
          const detail = await this.scrapeDetailPage(url);

          if (detail.source_id && !seenIds.has(detail.source_id)) {
            seenIds.add(detail.source_id);
            allListings.push({
              source_id: detail.source_id,
              url,
              title: detail.title || "",
              price: detail.price || 0,
              city: detail.city || "",
              type: detail.type || "house",
            });
          }
        } catch (e) {
          this.logger.warn(`Failed: ${url}`, { error: e instanceof Error ? e.message : String(e) });
        }
      }
    }

    return { listings: allListings, totalFound: allListings.length };
  }

  // ─── HELPERS ───

  private capitalize(str: string): string {
    return str.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }

  private normalizeType(raw: string): string {
    const lower = raw.toLowerCase();
    if (lower.includes("appartement") || lower.includes("apartment")) return "apartment";
    if (lower.includes("villa")) return "villa";
    if (lower.includes("studio")) return "studio";
    if (lower.includes("kantoor") || lower.includes("commercial") || lower.includes("bureau")) return "commercial";
    if (lower.includes("garage")) return "garage";
    if (lower.includes("grond") || lower.includes("terrain")) return "land";
    return "house";
  }
}