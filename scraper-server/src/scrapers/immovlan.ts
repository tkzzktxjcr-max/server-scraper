import { Page } from "playwright";
import { BaseScraper, JobLogger, SearchResultItem, ScraperFilters } from "./base.js";
import { PropertyData } from "../appwrite/client.js";

export class ImmovlanScraper extends BaseScraper {
  constructor(logger: JobLogger) {
    super("immovlan", "https://www.immovlan.be", logger);
  }

  buildSearchUrl(filters?: ScraperFilters): string {
    let url = "https://www.immovlan.be/en/search?transactionType=FOR_SALE&propertyTypes=HOUSE,APARTMENT&page=1";
    if (filters?.city) url += `&location=${encodeURIComponent(filters.city)}`;
    if (filters?.price_min) url += `&minPrice=${filters.price_min}`;
    if (filters?.price_max) url += `&maxPrice=${filters.price_max}`;
    return url;
  }

  async extractListingsFromDom(page: Page): Promise<SearchResultItem[]> {
    const selectors = [
      '.property-card',
      '.search-result',
      '.listing-item',
      '.result-item',
      '[data-testid="property"]',
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
      const links = document.querySelectorAll('a[href*="/detail/"]');
      const seen = new Set<string>();
      
      links.forEach(link => {
        const href = (link as HTMLAnchorElement).href;
        if (seen.has(href)) return;
        seen.add(href);
        
        const container = link.closest('article, .card, .item, .result') || link.parentElement;
        const title = container?.querySelector('h2, h3, .title')?.textContent?.trim() 
          || link.textContent?.trim() 
          || "";
        
        const priceText = container?.querySelector('.price')?.textContent?.trim() || "";
        const price = parseInt(priceText.replace(/[^\d]/g, '')) || 0;
        
        const idMatch = href.match(/\/detail\/(\d+)/);
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
        const link = card.querySelector('a[href*="/detail/"]') as HTMLAnchorElement | null;
        const url = link?.href || "";
        const idMatch = url.match(/\/detail\/(\d+)/);
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