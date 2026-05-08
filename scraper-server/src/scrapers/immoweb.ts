import { Page } from "playwright";
import { BaseScraper, JobLogger, SearchResultItem, ScraperFilters } from "./base.js";
import { normalizePropertyType } from "../utils/validation.js";
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

  async interceptApiListings(page: Page, timeoutMs: number = 8000): Promise<SearchResultItem[]> {
    const listings: SearchResultItem[] = [];
    const seenIds = new Set<string>();
    
    const handler = async (response: any) => {
      const url = response.url();
      if (!url.includes("immoweb.be")) return;
      if (!url.includes("/search/") && !url.includes("/classifieds/") && !url.includes("/api/")) return;
      
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
    
    // Wait for the specified time to collect responses
    await new Promise(r => setTimeout(r, timeoutMs));
    
    page.off("response", handler);
    return listings;
  }

  private parseApiResponse(data: unknown): SearchResultItem[] {
    const listings: SearchResultItem[] = [];
    try {
      const d = data as Record<string, unknown>;
      
      // Try multiple possible response structures
      const results = d.results || d.classifieds || d.items || d.data || d.properties || [];
      const items = Array.isArray(results) ? results : [];
      
      for (const item of items) {
        const i = item as Record<string, unknown>;
        const id = String(i.id || i.classifiedId || i.source_id || "");
        const url = String(i.url || i.permalink || i.detailUrl || i.propertyUrl || "");
        const title = String(i.title || (i.property as Record<string, unknown>)?.title || i.description || "");
        
        let price = 0;
        const transaction = i.transaction as Record<string, unknown> | undefined;
        if (transaction) {
          const sale = transaction.sale as Record<string, unknown> | undefined;
          price = Number(sale?.price || i.price || i.salePrice || 0);
        } else {
          price = Number(i.price || i.salePrice || i.displayPrice || 0);
        }
        
        const city = String(
          i.city || 
          (i.location as Record<string, unknown>)?.city || 
          (i.address as Record<string, unknown>)?.city || 
          ((i.property as Record<string, unknown>)?.location as Record<string, unknown>)?.city || 
          ""
        );
        
        const type = String(i.propertyType || i.type || i.propertyTypeId || "house");
        
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
    } catch (e) {
      this.logger.warn("Failed to parse API response", { error: e instanceof Error ? e.message : String(e) });
    }
    return listings;
  }

  async extractListingsFromDom(page: Page): Promise<SearchResultItem[]> {
    // First, try to wait for any content to appear
    const contentSelectors = [
      'iw-search-card',
      '[data-testid="search-card"]',
      '.card--result',
      '.search-results__item',
      '.property-card',
      '.classified',
      'article',
      '[class*="result"]',
      '[class*="card"]',
      '[data-testid]',
      '.listing',
    ];

    // Wait for any selector with a longer timeout
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

    // Ultimate fallback: any link containing /classified/
    return page.evaluate(() => {
      const listings: SearchResultItem[] = [];
      const links = document.querySelectorAll('a[href*="/classified/"]');
      const seen = new Set<string>();
      
      links.forEach(link => {
        const href = (link as HTMLAnchorElement).href;
        if (seen.has(href)) return;
        seen.add(href);
        
        // Try to find a container with more info
        let container = link.closest('article, .card, .item, iw-search-card, [data-testid], .listing, .result');
        if (!container) container = link.parentElement;
        
        const title = container?.querySelector('h2, h3, .title, [data-testid="title"], .card__title')?.textContent?.trim() 
          || link.textContent?.trim() 
          || "";
        
        const priceEl = container?.querySelector('.price, [data-testid="price"], .card__price, .sr-only');
        let priceText = "";
        if (priceEl) {
          // Check for sr-only price text
          priceText = priceEl.textContent?.trim() || "";
        }
        const price = parseInt(priceText.replace(/[^\d]/g, '')) || 0;
        
        const cityText = container?.querySelector('.location, .city, [data-testid="location"], .card__location')?.textContent?.trim() || "";
        
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
        
        const title = card.querySelector('h2, h3, .title, [data-testid="title"], .card__title')?.textContent?.trim() || "";
        
        // Try multiple price selectors
        let priceText = "";
        const priceSelectors = ['.price', '[data-testid="price"]', '.card__price', '.sr-only'];
        for (const ps of priceSelectors) {
          const el = card.querySelector(ps);
          if (el && el.textContent) {
            priceText = el.textContent.trim();
            if (priceText.match(/\d/)) break;
          }
        }
        const price = parseInt(priceText.replace(/[^\d]/g, '')) || 0;
        
        const city = card.querySelector('.location, .city, [data-testid="location"], .card__location')?.textContent?.trim() || "";
        
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
      
      const titleEl = document.querySelector('h1, .classified__title, [data-testid="title"], .property-title');
      result.title = titleEl?.textContent?.trim() || "";
      
      const priceEl = document.querySelector('.classified__price, [data-testid="price"], .price, .property-price');
      const priceText = priceEl?.textContent?.trim() || "";
      result.price = parseInt(priceText.replace(/[^\d]/g, '')) || 0;
      
      const descEl = document.querySelector('.classified__description, .description, [data-testid="description"], .property-description');
      result.description = descEl?.textContent?.trim() || "";
      
      const addrEl = document.querySelector('.classified__address, .address, [data-testid="address"], .property-address');
      const addressText = addrEl?.textContent?.trim() || "";
      result.address = addressText;
      result.city = addressText.split(',')[0]?.trim() || "";
      
      // Try to extract surface from text
      const bodyText = document.body.textContent || "";
      const surfaceMatch = bodyText.match(/(\d+(?:[.,]\d+)?)\s*m²/i);
      result.surface_sqm = surfaceMatch ? parseFloat(surfaceMatch[1].replace(',', '.')) : 0;
      
      const bedMatch = bodyText.match(/(\d+)\s*bedroom/i);
      result.bedrooms = bedMatch ? parseInt(bedMatch[1]) : 0;
      
      const bathMatch = bodyText.match(/(\d+)\s*bathroom/i);
      result.bathrooms = bathMatch ? parseInt(bathMatch[1]) : 0;
      
      return result;
    }) as Promise<Partial<PropertyData>>;
  }
}