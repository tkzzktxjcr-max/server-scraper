// @ts-nocheck
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
  rateLimit: {
    delayMs: parseInt(process.env.REQUEST_DELAY_MS || "2000", 10),
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