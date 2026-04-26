import dotenv from "dotenv";

// Load .env file if present (for local development)
dotenv.config();

export const config = {
  // Appwrite
  appwrite: {
    endpoint: process.env.APPWRITE_ENDPOINT || "https://cloud.appwrite.io/v1",
    project: process.env.APPWRITE_PROJECT || "",
    apiKey: process.env.APPWRITE_API_KEY || "",
    databaseId: process.env.APPWRITE_DATABASE_ID || "",
  },

  // Server
  server: {
    port: parseInt(process.env.PORT || "3001", 10),
    nodeEnv: process.env.NODE_ENV || "development",
  },

  // Browser
  browser: {
    headless: process.env.BROWSER_HEADLESS !== "false",
    timeout: parseInt(process.env.BROWSER_TIMEOUT || "60000", 10),
    maxPages: parseInt(process.env.BROWSER_MAX_PAGES || "5", 10),
  },

  // Rate Limiting
  rateLimit: {
    delayMs: parseInt(process.env.REQUEST_DELAY_MS || "2000", 10),
    maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS || "3", 10),
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "10", 10),
  },
} as const;

// Validate required config
if (!config.appwrite.apiKey && config.server.nodeEnv === "production") {
  console.warn("[Config] ⚠️  WARNING: APPWRITE_API_KEY is not set. Appwrite operations will fail.");
}

if (!config.appwrite.project && config.server.nodeEnv === "production") {
  console.warn("[Config] ⚠️  WARNING: APPWRITE_PROJECT is not set. Appwrite operations will fail.");
}