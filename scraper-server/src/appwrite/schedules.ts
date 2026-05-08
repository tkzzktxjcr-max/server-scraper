import { databases, APPWRITE_DATABASE_ID, COLLECTIONS } from "./client.js";
import { ID, Query } from "appwrite";
import { logger } from "../utils/logger.js";

// ─────────────────────────────────────────────
// TYPE DEFINITIONS
// ─────────────────────────────────────────────

export interface Schedule {
  $id: string;
  name: string;
  site_slug: string;
  cron_expression: string;
  filters: Record<string, unknown>;
  is_active: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_by: string;
  created_at: string;
}

// ─────────────────────────────────────────────
// COLLECTION CONSTANTS
// ─────────────────────────────────────────────

export const SCHEDULES_COLLECTION = "schedules";

// ─────────────────────────────────────────────
// CRUD OPERATIONS
// ─────────────────────────────────────────────

export async function getAllSchedules(): Promise<Schedule[]> {
  try {
    const response = await databases.listDocuments(
      APPWRITE_DATABASE_ID,
      SCHEDULES_COLLECTION,
      [Query.orderDesc("created_at")]
    );

    return response.documents.map((doc) => ({
      $id: doc.$id,
      name: doc.name,
      site_slug: doc.site_slug,
      cron_expression: doc.cron_expression,
      filters: typeof doc.filters === "string" ? JSON.parse(doc.filters) : doc.filters,
      is_active: doc.is_active ?? true,
      last_run_at: doc.last_run_at || null,
      next_run_at: doc.next_run_at || null,
      created_by: doc.created_by || "system",
      created_at: doc.created_at,
    }));
  } catch (error) {
    logger.error("Failed to fetch schedules", { error });
    return [];
  }
}

export async function getScheduleById(scheduleId: string): Promise<Schedule | null> {
  try {
    const doc = await databases.getDocument(
      APPWRITE_DATABASE_ID,
      SCHEDULES_COLLECTION,
      scheduleId
    );

    return {
      $id: doc.$id,
      name: doc.name,
      site_slug: doc.site_slug,
      cron_expression: doc.cron_expression,
      filters: typeof doc.filters === "string" ? JSON.parse(doc.filters) : doc.filters,
      is_active: doc.is_active ?? true,
      last_run_at: doc.last_run_at || null,
      next_run_at: doc.next_run_at || null,
      created_by: doc.created_by || "system",
      created_at: doc.created_at,
    };
  } catch (error) {
    logger.error(`Failed to fetch schedule ${scheduleId}`, { error });
    return null;
  }
}

export async function createSchedule(params: {
  name: string;
  site_slug: string;
  cron_expression: string;
  filters?: Record<string, unknown>;
  created_by?: string;
}): Promise<Schedule | null> {
  try {
    const scheduleId = ID.unique();

    const doc = await databases.createDocument(
      APPWRITE_DATABASE_ID,
      SCHEDULES_COLLECTION,
      scheduleId,
      {
        name: params.name,
        site_slug: params.site_slug,
        cron_expression: params.cron_expression,
        filters: JSON.stringify(params.filters || {}),
        is_active: true,
        last_run_at: null,
        next_run_at: null,
        created_by: params.created_by || "admin",
        created_at: new Date().toISOString(),
      }
    );

    logger.info(`Created schedule: ${params.name}`, { scheduleId });

    return {
      $id: doc.$id,
      name: doc.name,
      site_slug: doc.site_slug,
      cron_expression: doc.cron_expression,
      filters: typeof doc.filters === "string" ? JSON.parse(doc.filters) : doc.filters,
      is_active: true,
      last_run_at: null,
      next_run_at: null,
      created_by: doc.created_by,
      created_at: doc.created_at,
    };
  } catch (error) {
    logger.error("Failed to create schedule", { error, params });
    return null;
  }
}

export async function updateSchedule(
  scheduleId: string,
  updates: Partial<{
    name: string;
    site_slug: string;
    cron_expression: string;
    filters: Record<string, unknown>;
    is_active: boolean;
    last_run_at: string | null;
    next_run_at: string | null;
  }>
): Promise<Schedule | null> {
  try {
    const updateData: Record<string, unknown> = {};

    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.site_slug !== undefined) updateData.site_slug = updates.site_slug;
    if (updates.cron_expression !== undefined) updateData.cron_expression = updates.cron_expression;
    if (updates.filters !== undefined) updateData.filters = JSON.stringify(updates.filters);
    if (updates.is_active !== undefined) updateData.is_active = updates.is_active;
    if (updates.last_run_at !== undefined) updateData.last_run_at = updates.last_run_at;
    if (updates.next_run_at !== undefined) updateData.next_run_at = updates.next_run_at;

    const doc = await databases.updateDocument(
      APPWRITE_DATABASE_ID,
      SCHEDULES_COLLECTION,
      scheduleId,
      updateData
    );

    logger.info(`Updated schedule: ${scheduleId}`);

    return {
      $id: doc.$id,
      name: doc.name,
      site_slug: doc.site_slug,
      cron_expression: doc.cron_expression,
      filters: typeof doc.filters === "string" ? JSON.parse(doc.filters) : doc.filters,
      is_active: doc.is_active ?? true,
      last_run_at: doc.last_run_at || null,
      next_run_at: doc.next_run_at || null,
      created_by: doc.created_by || "system",
      created_at: doc.created_at,
    };
  } catch (error) {
    logger.error(`Failed to update schedule ${scheduleId}`, { error });
    return null;
  }
}

export async function deleteSchedule(scheduleId: string): Promise<boolean> {
  try {
    await databases.deleteDocument(
      APPWRITE_DATABASE_ID,
      SCHEDULES_COLLECTION,
      scheduleId
    );

    logger.info(`Deleted schedule: ${scheduleId}`);
    return true;
  } catch (error) {
    logger.error(`Failed to delete schedule ${scheduleId}`, { error });
    return false;
  }
}

export async function updateScheduleLastRun(
  scheduleId: string,
  lastRunAt: string,
  nextRunAt: string
): Promise<void> {
  try {
    await databases.updateDocument(
      APPWRITE_DATABASE_ID,
      SCHEDULES_COLLECTION,
      scheduleId,
      {
        last_run_at: lastRunAt,
        next_run_at: nextRunAt,
      }
    );
  } catch (error) {
    logger.error(`Failed to update schedule last run ${scheduleId}`, { error });
  }
}

export async function toggleScheduleActive(scheduleId: string, isActive: boolean): Promise<boolean> {
  try {
    await databases.updateDocument(
      APPWRITE_DATABASE_ID,
      SCHEDULES_COLLECTION,
      scheduleId,
      { is_active: isActive }
    );

    logger.info(`Schedule ${scheduleId} ${isActive ? "enabled" : "disabled"}`);
    return true;
  } catch (error) {
    logger.error(`Failed to toggle schedule ${scheduleId}`, { error });
    return false;
  }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

export function calculateNextRun(cronExpression: string, fromDate: Date = new Date()): Date | null {
  // Parse cron expression: minute hour day month weekday
  const parts = cronExpression.split(" ");
  if (parts.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Simple next occurrence calculation
  const next = new Date(fromDate);
  next.setSeconds(0);
  next.setMilliseconds(0);

  // Add at least 1 minute
  next.setMinutes(next.getMinutes() + 1);

  // For simplicity, calculate the next matching time (simplified implementation)
  // This is a basic approach; for production, consider using a proper cron library
  const targetMinute = minute === "*" ? next.getMinutes() : parseInt(minute, 10);
  const targetHour = hour === "*" ? next.getHours() : parseInt(hour, 10);

  // If target time is in the past, add a day
  if (targetHour < next.getHours() || (targetHour === next.getHours() && targetMinute <= next.getMinutes())) {
    next.setDate(next.getDate() + 1);
  }

  next.setHours(targetHour);
  next.setMinutes(targetMinute);

  return next;
}