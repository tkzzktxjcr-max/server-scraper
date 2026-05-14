import { Client, Databases, ID, Query } from "appwrite";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// ─────────────────────────────────────────────
// APPWRITE CLIENT
// ─────────────────────────────────────────────

const client = new Client()
  .setEndpoint(config.appwrite.endpoint)
  .setProject(config.appwrite.project);

export const databases = new Databases(client);

export const APPWRITE_DATABASE_ID = config.appwrite.databaseId;

// ─────────────────────────────────────────────
// COLLECTION IDS
// ─────────────────────────────────────────────

export const COLLECTIONS = {
  PROPERTIES: "properties",
  SCRAPING_SITES: "scraping_sites",
  SCRAPING_JOBS: "scraping_jobs",
  SCRAPING_LOGS: "scraping_logs",
} as const;

// ─────────────────────────────────────────────
// SITE OPERATIONS
// ─────────────────────────────────────────────

export async function getSiteBySlug(slug: string) {
  const response = await databases.listDocuments(
    APPWRITE_DATABASE_ID,
    COLLECTIONS.SCRAPING_SITES,
    [Query.equal("slug", slug), Query.limit(1)]
  );
  return response.documents[0] || null;
}

export async function updateSiteLastScrape(siteId: string, status: "success" | "failed") {
  await databases.updateDocument(
    APPWRITE_DATABASE_ID,
    COLLECTIONS.SCRAPING_SITES,
    siteId,
    {
      last_scrape_at: new Date().toISOString(),
      last_scrape_status: status,
    }
  );
}

// ─────────────────────────────────────────────
// JOB OPERATIONS
// ─────────────────────────────────────────────

export interface ScrapingJob {
  $id: string;
  site_id: string;
  status: "pending" | "running" | "completed" | "failed";
  trigger: "manual" | "scheduled" | "agent" | "realtime";
  filters: Record<string, unknown>;
  stats: { total_found: number; new_listings: number; updated: number; failed: number };
  started_at: string;
  completed_at: string;
  error_message: string;
  created_by: string;
}

export async function createJob(params: {
  siteId: string;
  trigger: "manual" | "agent" | "scheduled" | "realtime";
  filters?: Record<string, unknown>;
  createdBy?: string;
}): Promise<string> {
  const jobId = ID.unique();

  await databases.createDocument(
    APPWRITE_DATABASE_ID,
    COLLECTIONS.SCRAPING_JOBS,
    jobId,
    {
      site_id: params.siteId,
      status: "pending",
      trigger: params.trigger,
      filters: JSON.stringify(params.filters || {}),
      stats: JSON.stringify({ total_found: 0, new_listings: 0, updated: 0, failed: 0 }),
      started_at: new Date().toISOString(),
      completed_at: "",
      error_message: "",
      created_by: params.createdBy || "scraper-server",
    }
  );

  logger.info(`Created job document: ${jobId}`);
  return jobId;
}

export async function updateJobStatus(
  jobId: string,
  status: "pending" | "running" | "completed" | "failed",
  stats?: { total_found: number; new_listings: number; updated: number; failed: number },
  errorMessage?: string
) {
  const updateData: Record<string, unknown> = { status };

  if (stats) {
    updateData.stats = JSON.stringify(stats);
  }

  if (errorMessage) {
    updateData.error_message = errorMessage;
  }

  if (status === "completed" || status === "failed") {
    updateData.completed_at = new Date().toISOString();
  }

  await databases.updateDocument(
    APPWRITE_DATABASE_ID,
    COLLECTIONS.SCRAPING_JOBS,
    jobId,
    updateData
  );

  logger.info(`Updated job ${jobId} status to: ${status}`);
}

export async function getJob(jobId: string): Promise<ScrapingJob | null> {
  try {
    const doc = await databases.getDocument(
      APPWRITE_DATABASE_ID,
      COLLECTIONS.SCRAPING_JOBS,
      jobId
    );

    return {
      $id: doc.$id,
      site_id: doc.site_id,
      status: doc.status,
      trigger: doc.trigger,
      filters: typeof doc.filters === "string" ? JSON.parse(doc.filters) : doc.filters,
      stats: typeof doc.stats === "string" ? JSON.parse(doc.stats) : doc.stats,
      started_at: doc.started_at,
      completed_at: doc.completed_at,
      error_message: doc.error_message,
      created_by: doc.created_by,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// PROPERTY OPERATIONS (with improved deduplication)
// ─────────────────────────────────────────────

export interface PropertyData {
  site_id: string;
  source_id: string;
  url: string;
  title: string;
  description: string;
  price: number;
  surface_sqm: number;
  bedrooms: number;
  bathrooms: number;
  type: string;
  city: string;
  postal_code: string;
  province: string;
  latitude: number;
  longitude: number;
  address: string;
  photos: string[];
  agent_name: string;
  agent_phone: string;
  agent_agency: string;
  amenities: string[];
  energy_rating: string;
  year_built: number | null;
}

/**
 * Find existing property by source_id (primary) or URL (fallback)
 * This ensures proper deduplication even if source_id format changes
 */
export async function findExistingProperty(siteId: string, sourceId: string, url?: string): Promise<string | null> {
  // Primary: search by source_id
  if (sourceId) {
    try {
      const response = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        COLLECTIONS.PROPERTIES,
        [
          Query.equal("site_id", siteId),
          Query.equal("source_id", sourceId),
          Query.limit(1),
        ]
      );

      if (response.documents.length > 0) {
        return response.documents[0].$id;
      }
    } catch (error) {
      logger.warn(`Failed to search by source_id: ${sourceId}`, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Fallback: search by URL
  if (url) {
    try {
      const response = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        COLLECTIONS.PROPERTIES,
        [
          Query.equal("site_id", siteId),
          Query.equal("url", url),
          Query.limit(1),
        ]
      );

      if (response.documents.length > 0) {
        logger.info(`Found existing property by URL fallback (source_id missing?)`, { url, sourceId });
        return response.documents[0].$id;
      }
    } catch (error) {
      logger.warn(`Failed to search by URL: ${url}`, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  return null;
}

export async function createProperty(property: PropertyData): Promise<string> {
  const propertyId = ID.unique();

  await databases.createDocument(
    APPWRITE_DATABASE_ID,
    COLLECTIONS.PROPERTIES,
    propertyId,
    {
      ...property,
      is_active: true,
      scraped_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
    }
  );

  return propertyId;
}

export async function updateProperty(propertyId: string, updates: Partial<PropertyData> & { is_active?: boolean }) {
  await databases.updateDocument(
    APPWRITE_DATABASE_ID,
    COLLECTIONS.PROPERTIES,
    propertyId,
    {
      ...updates,
      last_updated: new Date().toISOString(),
    }
  );
}

export async function saveProperty(property: PropertyData): Promise<{ isNew: boolean; propertyId: string }> {
  // Use improved deduplication with URL fallback
  const existingId = await findExistingProperty(property.site_id, property.source_id, property.url);

  if (existingId) {
    await updateProperty(existingId, {
      ...property,
      is_active: true,
    });
    return { isNew: false, propertyId: existingId };
  } else {
    const newId = await createProperty(property);
    return { isNew: true, propertyId: newId };
  }
}

// ─────────────────────────────────────────────
// LOGGING OPERATIONS
// ─────────────────────────────────────────────

export async function createLog(params: {
  jobId: string;
  siteId: string;
  level: "INFO" | "WARNING" | "ERROR";
  message: string;
  metadata?: Record<string, unknown>;
}) {
  await databases.createDocument(
    APPWRITE_DATABASE_ID,
    COLLECTIONS.SCRAPING_LOGS,
    ID.unique(),
    {
      job_id: params.jobId,
      site_id: params.siteId,
      level: params.level,
      message: params.message,
      metadata: JSON.stringify(params.metadata || {}),
      created_at: new Date().toISOString(),
    }
  );
}