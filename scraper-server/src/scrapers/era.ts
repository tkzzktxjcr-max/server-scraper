import { Page } from "playwright";
import { BaseScraper, JobLogger, SearchResultItem, ScraperFilters } from "./base.js";
import { normalizePropertyType } from "../utils/validation.js";
import { PropertyData } from "../appwrite/client.js";

export class EraScraper extends BaseScraper {
  constructor(logger: JobLogger) {
    super("era", "https://www.era.be", logger);
  }

  buildSearchUrl(filters?: ScraperFilters): string {
    let url = "https://www.era.be/nl/te-koop";
    const params = new URLSearchParams();
    if (filters?.city) params.set("gemeente", filters.city);
    if (filters?.price_min) params.set("prijs_vanaf", String(filters.price_min));
    if (filters?.price_max) params.set("prijs_tot", String(filters.price_max));
    if (filters?.type) {
      const typeMap: Record<string, string> = { apartment: "appartement", house: "woning", villa: "woning", studio: "appartement", commercial: "handel" };
      const typeVal = typeMap[filters.type];
      if (typeVal) params.set("type", typeVal);
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  async interceptApiListings(_page: Page, _timeoutMs: number = 8000): Promise<SearchResultItem[]> {
    // ERA serves plain HTML — no JSON API to intercept
    return [];
  }

  async extractListingsFromDom(page: Page): Promise<SearchResultItem[]> {
    // Try known ERA teaser selectors
    const selectors = [
      'a[href*="/te-koop/"]',
      '[class*="teaser"]',
      'article',
      '[class*="property"]',
      '.card',
    ];

    for (const sel of selectors) {
      const count = await page.locator(sel).count();
      if (count > 0) {
        this.logger.info(`ERA: found ${count} elements with "${sel}"`);
      }
    }

    return page.evaluate(() => {
      const listings: SearchResultItem[] = [];
      const seen = new Set<string>();

      // ERA listing cards are <article> or divs containing a link to /te-koop/
      const cards = document.querySelectorAll('a[href*="/te-koop/"], article, [class*="teaser"], [class*="property"]');

      cards.forEach((card) => {
        const linkEl =
          card.tagName === 'A'
            ? (card as HTMLAnchorElement)
            : (card.querySelector('a[href*="/te-koop/"]') as HTMLAnchorElement | null);

        if (!linkEl) return;
        const url = linkEl.href || "";
        if (seen.has(url)) return;
        seen.add(url);

        const container = card.tagName === 'A' ? card.parentElement : card;
        if (!container) return;

        const title =
          container.querySelector("h2, h3, .title, [class*='title']")?.textContent?.trim() ||
          linkEl.getAttribute("title")?.trim() ||
          "";

        // Price — look for EUR symbol or price class
        const priceEl =
          container.querySelector("[class*='price'], [class*='prijs'], .price") ||
          Array.from(container.querySelectorAll("*")).find((el) =>
            /€\s*[\d\s.,]+/.test(el.textContent || "")
          );
        const priceText = priceEl?.textContent?.trim() || "";
        const price = parseInt(priceText.replace(/[^\d]/g, "")) || 0;

        // City — usually in the title or in a location element
        let city = "";
        const locationEl = container.querySelector("[class*='city'], [class*='location'], [class*='gemeente']");
        if (locationEl) {
          city = locationEl.textContent?.trim() || "";
        } else if (title) {
          // Try to extract city from title: "... in City" or "... te City"
          const match = title.match(/(?:in|te|à|a)\s+([A-Za-z\s-]+)$/i);
          if (match) city = match[1].trim();
        }

        // Extract ID from URL: /nl/te-koop/12345-city
        const idMatch = url.match(/\/te-koop\/(\d+)[-/]/);
        const source_id = idMatch ? idMatch[1] : url.split("/").pop()?.split("-")[0] || "";

        if (source_id && (title || price > 0)) {
          listings.push({
            source_id,
            url,
            title,
            price,
            city,
            type: "house",
          });
        }
      });

      return listings;
    }) as Promise<SearchResultItem[]>;
  }

  async extractDetailFromDom(page: Page): Promise<Partial<PropertyData>> {
    return page.evaluate(() => {
      const result: Partial<PropertyData> = {};

      result.title =
        document.querySelector("h1, .property-title, [class*='title']")?.textContent?.trim() || "";

      const priceText =
        document.querySelector("[class*='price'], [class*='prijs'], .price")?.textContent?.trim() || "";
      result.price = parseInt(priceText.replace(/[^\d]/g, "")) || 0;

      result.description =
        document.querySelector("[class*='description'], .description")?.textContent?.trim() || "";

      const addressText =
        document.querySelector("[class*='address'], .address, [class*='location']")?.textContent?.trim() || "";
      result.address = addressText;
      result.city = addressText.split(",")[0]?.trim() || "";

      // Surface from description or body
      const bodyText = document.body.textContent || "";
      const surfaceMatch = bodyText.match(/(\d+(?:[.,]\d+)?)\s*m²/i);
      result.surface_sqm = surfaceMatch ? parseFloat(surfaceMatch[1].replace(",", ".")) : 0;

      const bedMatch = bodyText.match(/(\d+)\s*(?:slaapkamer|bedroom|chambre)/i);
      result.bedrooms = bedMatch ? parseInt(bedMatch[1]) : 0;

      const bathMatch = bodyText.match(/(\d+)\s*(?:badkamer|bathroom|salle de bain)/i);
      result.bathrooms = bathMatch ? parseInt(bathMatch[1]) : 0;

      // Photos
      result.photos = Array.from(document.querySelectorAll("img"))
        .map((img) => (img as HTMLImageElement).src)
        .filter((src) => src && !src.includes("placeholder") && src.startsWith("http"));

      return result;
    }) as Promise<Partial<PropertyData>>;
  }
}
