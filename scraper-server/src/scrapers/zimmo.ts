import { Page } from "playwright";
import { BaseScraper, JobLogger, SearchResultItem, ScraperFilters } from "./base.js";
import { PropertyData } from "../appwrite/client.js";

export class ZimmoScraper extends BaseScraper {
  constructor(logger: JobLogger) {
    super("zimmo", "https://www.zimmo.be", logger);
  }

  buildSearchUrl(filters?: ScraperFilters): string {
    let url = "https://www.zimmo.be/nl/?pagina=1&transactionType=FOR_SALE";
    if (filters?.city) url += `&plaats=${encodeURIComponent(filters.city)}`;
    if (filters?.price_min) url += `&prijsVan=${filters.price_min}`;
    if (filters?.price_max) url += `&prijsTot=${filters.price_max}`;
    return url;
  }

  async interceptApiListings(page: Page): Promise<SearchResultItem[]> {
    const listings: SearchResultItem[] = [];
    
    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("zimmo.be") && (url.includes("/search/") || url.includes("/api/") || url.includes("/listings/"))) {
        try {
          const contentType = response.headers()["content-type"] || "";
          if (contentType.includes("application/json")) {
            const data = await response.json();
            const items = this.parseApiResponse(data);
            listings.push(...items);
          }
        } catch {}
      }
    });
    
    await new Promise(r => setTimeout(r, 5000));
    return listings;
  }

  private parseApiResponse(data: unknown): SearchResultItem[] {
    const listings: SearchResultItem[] = [];
    try {
      const d = data as Record<string, unknown>;
      const results = d.results || d.items || d.data || d.listings || [];
      const items = Array.isArray(results) ? results : [];
      
      for (const item of items) {
        const i = item as Record<string, unknown>;
        const id = String(i.id || i.listingId || i.source_id || "");
        const url = String(i.url || i.detailUrl || i.permalink || "");
        const title = String(i.title || (i.property as Record<string, unknown>)?.title || "");
        const price = Number(i.price || i.salePrice || (i.transaction as Record<string, unknown>)?.price || 0);
        const city = String(i.city || (i.location as Record<string, unknown>)?.city || (i.address as Record<string, unknown>)?.city || "");
        const type = String(i.propertyType || i.type || "house");
        
        if (id && title && price > 0) {
          listings.push({
            source_id: id,
            url: url || `https://www.zimmo.be/${id}`,
            title,
            price,
            city,
            type: type.toLowerCase(),
          });
        }
      }
    } catch {}
    return listings;
  }

  async extractListingsFromDom(page: Page): Promise<SearchResultItem[]> {
    const selectors = [
      '.property-card',
      '.search-result',
      '.listing-item',
      '.result-item',
      '[data-testid="property"]',
      '[class*="card"]',
      '[class*="result"]',
    ];

    for (const selector of selectors) {
      const count = await page.locator(selector).count();
      if (count > 0) {
        this.logger.info(`Found ${count} cards with selector: ${selector}`);
        return this.extractWithSelector(page, selector);
      }
    }

    return page.evaluate(() => {
      const listings: SearchResultItem[] = [];
      const links = document.querySelectorAll('a');
      const seen = new Set<string>();
      
      links.forEach(link => {
        const href = (link as HTMLAnchorElement).href;
        if (!href.match(/\d{5,}/)) return;
        if (seen.has(href)) return;
        seen.add(href);
        
        const container = link.closest('article, .card, .item, .result') || link.parentElement;
        const title = container?.querySelector('h2, h3, .title')?.textContent?.trim() 
          || link.getAttribute('title') 
          || "";
        
        const priceText = container?.querySelector('.price')?.textContent?.trim() || "";
        const price = parseInt(priceText.replace(/[^\d]/g, '')) || 0;
        
        const idMatch = href.match(/(\d{6,})/);
        const source_id = idMatch ? idMatch[1] : "";
        
        if (source_id && title && price > 0) {
          listings.push({ source_id, url: href, title, price, city: "", type: "house" });
        }
      });
      return listings;
    }) as Promise<SearchResultItem[]>;
  }

  private async extractWithSelector(page: Page, selector: string): Promise<SearchResultItem[]> {
    return page.evaluate((sel) => {
      const listings: SearchResultItem[] = [];
      document.querySelectorAll(sel).forEach(card => {
        const link = card.querySelector('a') as HTMLAnchorElement | null;
        const url = link?.href || "";
        const idMatch = url.match(/(\d{6,})/);
        const source_id = idMatch ? idMatch[1] : "";
        const title = card.querySelector('h2, h3, .title')?.textContent?.trim() || "";
        const priceText = card.querySelector('.price')?.textContent?.trim() || "";
        const price = parseInt(priceText.replace(/[^\d]/g, '')) || 0;
        const city = card.querySelector('.location, .city')?.textContent?.trim() || "";
        
        if (source_id && title && price > 0) {
          listings.push({ source_id, url, title, price, city, type: "house" });
        }
      });
      return listings;
    }, selector) as Promise<SearchResultItem[]>;
  }

  async extractDetailFromDom(page: Page): Promise<Partial<PropertyData>> {
    return page.evaluate(() => {
      const result: Partial<PropertyData> = {};
      result.title = document.querySelector('h1, .property-title')?.textContent?.trim() || "";
      const priceText = document.querySelector('.price, .property-price')?.textContent?.trim() || "";
      result.price = parseInt(priceText.replace(/[^\d]/g, '')) || 0;
      result.description = document.querySelector('.description, .property-description')?.textContent?.trim() || "";
      return result;
    }) as Promise<Partial<PropertyData>>;
  }
}