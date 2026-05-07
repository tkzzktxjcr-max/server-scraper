import { Page } from "playwright";
import { BaseScraper, JobLogger, SearchResultItem, ScraperFilters } from "./base.js";
import { cleanString, cleanNumber, cleanInt, normalizePropertyType } from "../utils/validation.js";
import { PropertyData } from "../appwrite/client.js";

export class ImmowebScraper extends BaseScraper {
  constructor(logger: JobLogger) {
    super("immoweb", "https://www.immoweb.be", logger);
  }

  buildSearchUrl(filters?: ScraperFilters): string {
    let url = "https://www.immoweb.be/en/search/house-and-apartment/for-sale?countries=BE&page=1&orderBy=relevance";
    if (filters?.city) url += `&searchRadius=0&towns=${encodeURIComponent(filters.city)}`;
    if (filters?.price_min) url += `&minPrice=${filters.price_min}`;
    if (filters?.price_max) url += `&maxPrice=${filters.price_max}`;
    if (filters?.type) {
      const typeMap: Record<string, string> = { apartment: "APARTMENT", house: "HOUSE", villa: "HOUSE", studio: "APARTMENT", commercial: "COMMERCIAL" };
      url += `&propertyTypes=${typeMap[filters.type] || "HOUSE,APARTMENT"}`;
    }
    return url;
  }

  async interceptApiListings(page: Page): Promise<SearchResultItem[]> {
    const listings: SearchResultItem[] = [];
    
    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("immoweb.be") && (url.includes("/search/") || url.includes("/classifieds/") || url.includes("/api/"))) {
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
    
    // Wait a bit for API calls
    await new Promise(r => setTimeout(r, 5000));
    return listings;
  }

  private parseApiResponse(data: unknown): SearchResultItem[] {
    const listings: SearchResultItem[] = [];
    try {
      const d = data as Record<string, unknown>;
      const results = d.results || d.classifieds || d.items || d.data || [];
      const items = Array.isArray(results) ? results : [];
      
      for (const item of items) {
        const i = item as Record<string, unknown>;
        const id = String(i.id || i.classifiedId || i.source_id || "");
        const url = String(i.url || i.permalink || i.detailUrl || "");
        const title = String(i.title || (i.property as Record<string, unknown>)?.title || i.description || "");
        
        // Safely extract price from nested transaction object
        let price = 0;
        const transaction = i.transaction as Record<string, unknown> | undefined;
        if (transaction) {
          const sale = transaction.sale as Record<string, unknown> | undefined;
          price = Number(sale?.price || i.price || i.salePrice || 0);
        } else {
          price = Number(i.price || i.salePrice || 0);
        }
        
        const city = String(i.city || (i.location as Record<string, unknown>)?.city || (i.address as Record<string, unknown>)?.city || "");
        const type = String(i.propertyType || i.type || "house");
        
        if (id && title && price > 0) {
          listings.push({
            source_id: id,
            url: url || `https://www.immoweb.be/en/classified/${id}`,
            title,
            price,
            city,
            type: normalizePropertyType(type),
          });
        }
      }
    } catch {}
    return listings;
  }

  async extractListingsFromDom(page: Page): Promise<SearchResultItem[]> {
    // Try multiple known selectors
    const selectors = [
      'iw-search-card',
      '[data-testid="search-card"]',
      '.card--result',
      '.search-results__item',
      '.property-card',
      '.classified',
      '[class*="result"]',
      '[class*="card"]',
    ];

    for (const selector of selectors) {
      const count = await page.locator(selector).count();
      if (count > 0) {
        this.logger.info(`Found ${count} cards with selector: ${selector}`);
        return this.extractWithSelector(page, selector);
      }
    }

    // Ultimate fallback: any link containing /classified/
    return page.evaluate(() => {
      const listings: SearchResultItem[] = [];
      const links = document.querySelectorAll('a[href*="/classified/"]');
      const seen = new Set<string>();
      
      links.forEach(link => {
        const href = (link as HTMLAnchorElement).href;
        if (seen.has(href)) return;
        seen.add(href);
        
        const container = link.closest('article, .card, .item, iw-search-card, [data-testid]') || link.parentElement;
        const title = container?.querySelector('h2, h3, .title, [data-testid="title"]')?.textContent?.trim() 
          || link.textContent?.trim() 
          || "";
        
        const priceText = container?.querySelector('.price, [data-testid="price"]')?.textContent?.trim() || "";
        const price = parseInt(priceText.replace(/[^\d]/g, '')) || 0;
        
        const cityText = container?.querySelector('.location, .city, [data-testid="location"]')?.textContent?.trim() || "";
        
        const idMatch = href.match(/\/classified\/(\d+)/);
        const source_id = idMatch ? idMatch[1] : "";
        
        if (source_id && title && price > 0) {
          listings.push({ source_id, url: href, title, price, city: cityText, type: "house" });
        }
      });
      return listings;
    }) as Promise<SearchResultItem[]>;
  }

  private async extractWithSelector(page: Page, selector: string): Promise<SearchResultItem[]> {
    return page.evaluate((sel) => {
      const listings: SearchResultItem[] = [];
      const cards = document.querySelectorAll(sel);
      
      cards.forEach(card => {
        const linkEl = card.querySelector('a[href*="/classified/"]') as HTMLAnchorElement | null;
        const url = linkEl?.href || "";
        const idMatch = url.match(/\/classified\/(\d+)/);
        const source_id = idMatch ? idMatch[1] : "";
        
        const title = card.querySelector('h2, h3, .title, [data-testid="title"]')?.textContent?.trim() || "";
        const priceText = card.querySelector('.price, [data-testid="price"]')?.textContent?.trim() || "";
        const price = parseInt(priceText.replace(/[^\d]/g, '')) || 0;
        const city = card.querySelector('.location, .city, [data-testid="location"]')?.textContent?.trim() || "";
        
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
      
      const titleEl = document.querySelector('h1, .classified__title, [data-testid="title"]');
      result.title = titleEl?.textContent?.trim() || "";
      
      const priceEl = document.querySelector('.classified__price, [data-testid="price"], .price');
      const priceText = priceEl?.textContent?.trim() || "";
      result.price = parseInt(priceText.replace(/[^\d]/g, '')) || 0;
      
      const descEl = document.querySelector('.classified__description, .description, [data-testid="description"]');
      result.description = descEl?.textContent?.trim() || "";
      
      const addrEl = document.querySelector('.classified__address, .address, [data-testid="address"]');
      const addressText = addrEl?.textContent?.trim() || "";
      result.address = addressText;
      result.city = addressText.split(',')[0]?.trim() || "";
      
      const surfaceText = document.body.textContent?.match(/(\d+)\s*m²/)?.[1] || "0";
      result.surface_sqm = parseInt(surfaceText) || 0;
      
      const bedMatch = document.body.textContent?.match(/(\d+)\s*bedroom/i);
      result.bedrooms = bedMatch ? parseInt(bedMatch[1]) : 0;
      
      return result;
    }) as Promise<Partial<PropertyData>>;
  }
}