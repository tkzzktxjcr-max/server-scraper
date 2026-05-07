import dotenv from "dotenv";
dotenv.config();

export const config = {
  appwrite: {
    endpoint: process.env.APPWRITE_ENDPOINT || "https://cloud.appwrite.io/v1",
    project: process.env.APPWRITE_PROJECT || "",
    apiKey: process.env.APPWRITE_API_KEY || "",
    databaseId: process.env.APPWRITE_DATABASE_ID || "",
  },
  server: {
    port: parseInt(process.env.PORT || "3001", 10),
    nodeEnv: process.env.NODE_ENV || "development",
  },
  browser: {
    headless: process.env.BROWSER_HEADLESS !== "false",
    timeout: parseInt(process.env.BROWSER_TIMEOUT || "60000", 10),
    maxPages: parseInt(process.env.BROWSER_MAX_PAGES || "5", 10),
  },
  scraper: {
    maxPages: parseInt(process.env.MAX_PAGES || "5", 10),
    maxRetries: parseInt(process.env.MAX_RETRIES || "3", 10),
    retryBaseDelay: parseInt(process.env.RETRY_BASE_DELAY || "2000", 10),
    detailTimeout: parseInt(process.env.DETAIL_TIMEOUT || "30000", 10),
  },
  proxy: {
    enabled: process.env.PROXY_ENABLED === "true",
    url: process.env.PROXY_URL || "",
    username: process.env.PROXY_USERNAME || "",
    password: process.env.PROXY_PASSWORD || "",
  },
  rateLimit: {
    delayMs: parseInt(process.env.REQUEST_DELAY_MS || "2000", 10),
    jitterMs: parseInt(process.env.REQUEST_JITTER_MS || "1000", 10),
    maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS || "3", 10),
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "10", 10),
  },
};

if (!config.appwrite.apiKey && config.server.nodeEnv === "production") {
  console.warn("[Config] WARNING: APPWRITE_API_KEY is not set.");
}
if (!config.appwrite.project && config.server.nodeEnv === "production") {
  console.warn("[Config] WARNING: APPWRITE_PROJECT is not set.");
}