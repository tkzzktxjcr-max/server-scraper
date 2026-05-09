import { chromium } from "playwright";

async function test() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    const url = "https://www.era.be/nl/te-koop";
    console.log(`Testing: ${url}\n`);
    
    // Log responses
    page.on("response", async (res) => {
      const u = res.url();
      if (u.includes("era.be") && res.status() >= 400) {
        console.log(`[BLOCKED] ${u} -> ${res.status()}`);
      }
    });
    
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    const title = await page.title().catch(() => "no-title");
    console.log(`Title: ${title}`);
    
    // Check for common listing selectors
    const selectors = [
      '[data-listing]', '.property-card', '.listing-item',
      'article', '.card', '[class*="property"]',
      '[class*="teaser"]', '.result-item'
    ];
    
    for (const sel of selectors) {
      const count = await page.locator(sel).count();
      if (count > 0) console.log(`Selector "${sel}": ${count} matches`);
    }
    
    // Extract listing data via evaluate
    const listings = await page.evaluate(() => {
      const results: any[] = [];
      // Try to find any clickable cards with prices
      const cards = document.querySelectorAll('a[href*="/te-koop/"], .property-card, article, [class*="teaser"]');
      cards.forEach(card => {
        const el = card as HTMLElement;
        const link = el.tagName === 'A' ? (el as HTMLAnchorElement).href 
          : el.querySelector('a[href*="/te-koop/"]')?.getAttribute('href') || '';
        
        const title = el.querySelector('h2, h3, .title')?.textContent?.trim() || '';
        const priceEl = el.querySelector('[class*="price"], [class*="prijs"], .price');
        const priceText = priceEl?.textContent?.trim() || '';
        const price = parseInt(priceText.replace(/[^\d]/g, '')) || 0;
        
        const city = el.querySelector('[class*="city"], [class*="location"], [class*="gemeente"]')?.textContent?.trim() || '';
        const img = el.querySelector('img')?.getAttribute('src') || '';
        
        if (link && (title || price > 0)) {
          results.push({ link, title, price, city, img: img.substring(0, 60) });
        }
      });
      return results.slice(0, 5);
    });
    
    console.log(`\n=== Found ${listings.length} listings ===`);
    if (listings.length > 0) {
      listings.forEach((l, i) => console.log(`  ${i+1}. ${l.title || 'No title'} | ${l.price}€ | ${l.city}`));
      console.log("\n✅ SUCCESS — listings found via DOM");
    } else {
      console.log("❌ No listings found via DOM evaluation");
    }
    
    process.exit(listings.length > 0 ? 0 : 1);
  } catch (e) {
    console.error("❌ CRASH:", e);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

test();
