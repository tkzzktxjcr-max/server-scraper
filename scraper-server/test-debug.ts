import { chromium } from "playwright";

async function debug() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Log all network responses
  page.on("response", async (res) => {
    const url = res.url();
    if (url.includes("immoweb") || url.includes("zimmo") || url.includes("immovlan")) {
      const status = res.status();
      if (status >= 400) {
        console.log(`[BLOCKED] ${url} → ${status}`);
        try {
          const body = await res.text();
          if (body.length < 500) console.log("  Body:", body);
        } catch {}
      }
    }
  });

  // Test Immoweb
  console.log("=== IMMOWEB ===");
  try {
    await page.goto("https://www.immoweb.be/en/search/house-and-apartment/for-sale?countries=BE&page=1", { waitUntil: "domcontentloaded", timeout: 30000 });
    const title = await page.title().catch(() => "no-title");
    const body = await page.content();
    console.log(`Title: ${title}`);
    console.log(`Body length: ${body.length}`);
    // Check for captcha/block keywords
    const lower = body.toLowerCase();
    const checks = ["cloudflare", "captcha", "access denied", "forbidden", "blocked", "challenge", "incapsula", "ddos", "security", "checking your browser", "just a moment"];
    for (const kw of checks) {
      if (lower.includes(kw)) console.log(`  → Contains "${kw}"`);
    }
  } catch (e) {
    console.error("Error:", e);
  }

  // Navigator.webdriver check
  const isHeadless = await page.evaluate(() => !!(navigator as any).webdriver);
  console.log(`navigator.webdriver detected by JS: ${isHeadless}`);

  await browser.close();
}
debug();
