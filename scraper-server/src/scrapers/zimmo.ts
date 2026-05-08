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

  async interceptApiListings(page: Page, timeoutMs: number = 8000): Promise<SearchResultItem[]> {
    const listings: SearchResultItem[] = [];
    const seenIds = new Set<string>();
    
    const handler = async (response: any) => {
      const url = response.url();
      if (!url.includes("zimmo.be")) return;
      if (!url.includes("/search/") && !url.includes("/api/") && !url.includes("/listings/")) return;
      
      try {
        const contentType = response.headers()["content-type"] || "";
        if (!contentType.includes("application/json")) return;
        
        const data = await response.json();
        const items = this.parseApiResponse(data);
        
        for (const item of items) {
          if (!seenIds.has(item.source_id)) {
            seenIds.add(item.source_id);
            listings.push(item);
          }
        }
      } catch {}
    };
    
    page.on("response", handler);
    await new Promise(r => setTimeout(r, timeoutMs));
    page.off("response", handler);
    return listings;
  }

  private parseApiResponse(data: unknown): SearchResultItem[] {
    const listings: SearchResultItem[] = [];
    try {
      const d = data as Record<string, unknown>;
      const results = d.results || d.items || d.data || d.listings || d.properties || [];
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
    const contentSelectors = [
      '.property-card',
      '.search-result',
      '.listing-item',
      '.result-item',
      '[data-testid="property"]',
      'article',
      '[class*="card"]',
      '[class*="result"]',
      '[data-testid]',
      '.listing',
    ];

    let foundSelector = null;
    for (const selector of contentSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 10000 });
        const count = await page.locator(selector).count();
        if (count > 0) {
          foundSelector = selector;
          this.logger.info(`Content loaded with selector: ${selector} (${count} items)`);
          break;
        }
      } catch {}
    }

    if (foundSelector) {
      const results = await this.extractWithSelector(page, foundSelector);
      if (results.length > 0) return results;
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
        
        const container = link.closest('article, .card, .item, .result, .listing') || link.parentElement;
        const title = container?.querySelector('h2, h3, .title')?.textContent?.trim() 
          || link.getAttribute('title') 
          || "";
        
        const priceText = container?.querySelector('.price, .property-price')?.textContent?.trim() || "";
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
        const priceText = card.querySelector('.price, .property-price')?.textContent?.trim() || "";
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