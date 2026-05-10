/**
 * ERA HTTP-only scraper — no Playwright, pure HTTP requests.
 * Uses ERA sitemap.xml to discover all city listing pages, then parses
 * the HTML with cheerio-like regex extraction.
 */
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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,nl;q=0.8",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
    return res.text();
  }

  /**
   * Fetch sitemap index, return all "te-koop" sub-sitemap URLs.
   */
  async getSitemapPages(): Promise<string[]> {
    this.logger.info("Fetching ERA sitemap index...");
    const xml = await this.httpGet(this.sitemapUrl);
    // Parse sitemapindex → loc
    const urls: string[] = [];
    const matches = xml.matchAll(/<loc>([^<]+)<\/loc>/g);
    for (const match of matches) {
      const url = match[1];
      if (url.includes("sitemap.xml?page=")) urls.push(url);
    }
    this.logger.info(`Found ${urls.length} sitemap pages`);
    return urls;
  }

  /**
   * From a sitemap page, extract all "te-koop/{city}" URLs.
   */
  async getCityUrls(sitemapPageUrl: string): Promise<string[]> {
    const xml = await this.httpGet(sitemapPageUrl);
    const urls: string[] = [];
    const matches = xml.matchAll(/<loc>([^<]+)<\/loc>/g);
    for (const match of matches) {
      const url = match[1];
      if (url.includes("/te-koop/")) urls.push(url);
    }
    return urls;
  }

  /**
   * Scrape a single ERA city page (e.g. /nl/te-koop/brussel) for listings.
   */
  async scrapeCityPage(url: string): Promise<SearchResultItem[]> {
    this.logger.info(`Fetching city page: ${url}`);
    const html = await this.httpGet(url);

    const listings: SearchResultItem[] = [];
    const seen = new Set<string>();

    // ERA city pages have listing cards in <article> or div containers
    // Strategy: find all links to /nl/te-koop/detail/xxx and extract nearby text
    const linkPattern = /href="(\/nl\/te-koop\/[^"]+)"/g;
    const pricePattern = /(€\s*[\d\s.,]+)/g;

    // Simple approach: split by article/div and extract per-card
    const cardChunks = html.split(/<article|<div class="[^"]*(?:card|teaser|property|listing)[^"]*"/i);

    for (const chunk of cardChunks.slice(1)) {
      const linkMatch = chunk.match(/href="(\/nl\/te-koop\/[^"]+)"/);
      if (!linkMatch) continue;
      const link = this.baseUrl + linkMatch[1];

      if (seen.has(link)) continue;
      seen.add(link);

      const priceMatch = chunk.match(/(€\s*[\d\s.,]+)/);
      const price = priceMatch ? parseInt(priceMatch[1].replace(/[^\d]/g, "")) : 0;

      // Title: try h2/h3 content, or alt text of image
      const titleMatch = chunk.match(/<h[23][^>]*>(.*?)<\/h[23]>/i);
      const altMatch = chunk.match(/alt="([^"]{10,})"/);
      const title = titleMatch
        ? this.stripHtml(titleMatch[1])
        : altMatch
          ? altMatch[1]
          : "";

      // City from URL: /nl/te-koop/city-name → city-name
      const cityMatch = link.match(/\/te-koop\/([^/]+)/);
      const city = cityMatch ? this.capitalize(cityMatch[1].replace(/-/g, " ")) : "";

      // Extract source_id from URL
      const idMatch = link.match(/-(\d+)$/);
      const source_id = idMatch ? idMatch[1] : link.split("/").pop() || "";

      if (source_id && (title || price > 0)) {
        listings.push({
          source_id,
          url: link,
          title,
          price,
          city,
          type: "house",
        });
      }
    }

    this.logger.info(`Scraped ${listings.length} listings from ${url}`);
    return listings;
  }

  /**
   * Scrape detail page for full property data.
   */
  async scrapeDetailPage(url: string): Promise<Partial<PropertyData>> {
    this.logger.info(`Fetching detail: ${url}`);
    const html = await this.httpGet(url);

    const title = this.extractMeta(html, "og:title") || this.extractBetween(html, "<h1", "</h1>");
    const desc = this.extractMeta(html, "og:description") || "";
    const price = this.extractPrice(html);
    const city = this.extractMeta(html, "og:locality") || "";

    // Surface, bedrooms from description text
    const surfaceMatch = html.match(/(\d+(?:[.,]\d+)?)\s*m²/i);
    const bedMatch = html.match(/(\d+)\s*slaapkamer/i);
    const bathMatch = html.match(/(\d+)\s*badkamer/i);

    return {
      title,
      description: desc,
      price,
      surface_sqm: surfaceMatch ? parseFloat(surfaceMatch[1].replace(",", ".")) : 0,
      bedrooms: bedMatch ? parseInt(bedMatch[1]) : 0,
      bathrooms: bathMatch ? parseInt(bathMatch[1]) : 0,
      city,
      address: city,
      photos: this.extractImages(html),
      type: "house",
    };
  }

  /**
   * Main entry: scrape all ERA listings via sitemap + HTTP.
   */
  async run(filters?: ScraperFilters): Promise<{
    listings: SearchResultItem[];
    totalFound: number;
  }> {
    const allListings: SearchResultItem[] = [];
    const seenIds = new Set<string>();

    const sitemapPages = await this.getSitemapPages();
    const maxSitemaps = 2; // Limit to 2 sitemap pages for safety (2000 cities × 2)

    for (const sitemapPage of sitemapPages.slice(0, maxSitemaps)) {
      const cityUrls = await this.getCityUrls(sitemapPage);
      this.logger.info(`Sitemap ${sitemapPage}: ${cityUrls.length} cities`);

      // Filter by city if requested
      const filteredCities = filters?.city
        ? cityUrls.filter((u) => u.toLowerCase().includes(filters.city!.toLowerCase()))
        : cityUrls;

      // Limit cities per run
      const maxCities = 5;
      for (const cityUrl of filteredCities.slice(0, maxCities)) {
        try {
          await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000)); // 2-4s delay
          const listings = await this.scrapeCityPage(cityUrl);
          for (const l of listings) {
            if (!seenIds.has(l.source_id)) {
              seenIds.add(l.source_id);
              allListings.push(l);
            }
          }
        } catch (e) {
          this.logger.warn(`Failed city ${cityUrl}`, {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    return { listings: allListings, totalFound: allListings.length };
  }

  // ─── HELPERS ───

  private stripHtml(raw: string): string {
    return raw.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  }

  private capitalize(str: string): string {
    return str
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  private extractMeta(html: string, property: string): string {
    const match = html.match(
      new RegExp(
        `<meta[^>]+property="${property}"[^>]+content="([^"]+)"`,
        "i"
      )
    );
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
    // Look for price patterns near meta or in body
    const patterns = [
      /property="product:price:amount"[^>]+content="([\d.]+)"/i,
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
    const matches = html.matchAll(
      /property="og:image"[^>]+content="([^"]+)"/g
    );
    for (const m of matches) imgs.push(m[1]);
    if (imgs.length === 0) {
      const altMatches = html.matchAll(
        /class="[^"]*gallery[^"]*"[^}]*src="([^"]+)"/gi
      );
      for (const m of altMatches) imgs.push(m[1]);
    }
    return imgs.filter((u) => u.startsWith("http"));
  }
}
