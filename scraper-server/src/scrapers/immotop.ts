import { ScraperFilters, JobLogger, SearchResultItem } from "./base.js";
import { PropertyData } from "../appwrite/client.js";

/**
 * Immotop.be HTTP-only scraper — no Playwright needed.
 * The site serves server-rendered HTML with property listings.
 */
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
    if (filters?.price_min) params.set("price_min", String(filters.price_min));
    if (filters?.price_max) params.set("price_max", String(filters.price_max));
    if (filters?.type) params.set("type", filters.type);
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  private async httpGet(url: string): Promise<string> {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,nl;q=0.8",
        "Cache-Control": "max-age=0",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
    return res.text();
  }

  async extractListings(url: string): Promise<SearchResultItem[]> {
    this.logger.info(`Fetching: ${url}`);
    const html = await this.httpGet(url);

    const listings: SearchResultItem[] = [];
    const seen = new Set<string>();

    // Immotop listings are in cards with specific structure
    // Strategy: find all property links and surrounding context
    const cardRegex = /<div[^}]*class="[^"]*(?:listing|property|card|result|item)[^"]*"[^}]*>([\s\S]*?)<\/div>/gi;
    let match: RegExpExecArray | null;

    while ((match = cardRegex.exec(html)) !== null) {
      const chunk = match[1];

      const linkMatch = chunk.match(/href="(\/[^"]*(?:detail|annonce|property|listing)[^"]*)"/i);
      if (!linkMatch) continue;
      const link = this.baseUrl + linkMatch[1];
      if (seen.has(link)) continue;
      seen.add(link);

      const priceMatch = chunk.match(/(\d[\d\s.,]*)\s*€/);
      const price = priceMatch ? parseInt(priceMatch[1].replace(/[^\d]/g, "")) : 0;

      const titleMatch = chunk.match(/<h[23][^>]*>(.*?)<\/h[23]>/i);
      const title = titleMatch ? this.stripHtml(titleMatch[1]) : "";

      const cityMatch = chunk.match(/(?:in|te|à)\s+([A-Za-z\s-]+)/i) || chunk.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)*),?\s*\d{4}/);
      const city = cityMatch ? cityMatch[1].trim() : "";

      const idMatch = link.match(/(\d+)/);
      const source_id = idMatch ? idMatch[1] : link.split("/").pop() || "";

      if (source_id && (title || price > 0)) {
        listings.push({ source_id, url: link, title, price, city, type: "house" });
      }
    }

    // Fallback: if no cards found, search all links with prices
    if (listings.length === 0) {
      const linkMatches = html.matchAll(/href="(\/[^"]*(?:detail|annonce)[^"]*)"/gi);
      for (const lm of linkMatches) {
        const link = this.baseUrl + lm[1];
        if (seen.has(link)) continue;
        seen.add(link);

        const priceNear = html.substring(
          Math.max(0, html.indexOf(lm[0]) - 300),
          html.indexOf(lm[0]) + 300
        );
        const priceMatch = priceNear.match(/(\d[\d\s.,]*)\s*€/);
        const price = priceMatch ? parseInt(priceMatch[1].replace(/[^\d]/g, "")) : 0;

        const idMatch = link.match(/(\d+)/);
        const source_id = idMatch ? idMatch[1] : "";

        if (source_id && price > 0) {
          listings.push({ source_id, url: link, title: "", price, city: "", type: "house" });
        }
      }
    }

    this.logger.info(`Found ${listings.length} listings`);
    return listings;
  }

  async scrapeDetailPage(url: string): Promise<Partial<PropertyData>> {
    this.logger.info(`Fetching detail: ${url}`);
    const html = await this.httpGet(url);

    const title = this.extractMeta(html, "og:title") || this.extractBetween(html, "<h1", "</h1>");
    const desc = this.extractMeta(html, "og:description") || "";
    const price = this.extractPrice(html);

    const surfaceMatch = html.match(/(\d+(?:[.,]\d+)?)\s*m²/i);
    const bedMatch = html.match(/(\d+)\s*(?:slaapkamer|bedroom|chambre)/i);
    const bathMatch = html.match(/(\d+)\s*(?:badkamer|bathroom)/i);

    return {
      title,
      description: desc,
      price,
      surface_sqm: surfaceMatch ? parseFloat(surfaceMatch[1].replace(",", ".")) : 0,
      bedrooms: bedMatch ? parseInt(bedMatch[1]) : 0,
      bathrooms: bathMatch ? parseInt(bathMatch[1]) : 0,
      photos: this.extractImages(html),
      type: "house",
    };
  }

  private stripHtml(raw: string): string {
    return raw.replace(/<[^\u003e]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  private extractMeta(html: string, property: string): string {
    const match = html.match(new RegExp(`<meta[^\u003e]+property="${property}"[^\u003e]+content="([^"]+)"`, "i"));
    return match ? match[1] : "";
  }

  private extractBetween(html: string, start: string, end: string): string {
    const idx = html.indexOf(start);
    if (idx === -1) return "";
    const startIdx = html.indexOf(">", idx) + 1;
    const endIdx = html.indexOf(end, startIdx);
    return endIdx > startIdx ? this.stripHtml(html.slice(startIdx, endIdx)) : "";
  }

  private extractPrice(html: string): number {
    const patterns = [
      /property="product:price:amount"[^\u003e]+content="([\d.]+)"/i,
      /class="[^"]*price[^"]*"[^}]*\u003e\s*([\d\s.,]+)\s*€/i,
      /€\s*([\d\s.,]+)/,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) {
        const clean = m[1].replace(/[^\d]/g, "");
        if (clean) return parseInt(clean);
      }
    }
    return 0;
  }

  private extractImages(html: string): string[] {
    const imgs: string[] = [];
    const matches = html.matchAll(/property="og:image"[^\u003e]+content="([^"]+)"/g);
    for (const m of matches) imgs.push(m[1]);
    return imgs.filter((u) => u.startsWith("http"));
  }
}
