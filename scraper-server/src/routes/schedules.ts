import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  getAllSchedules,
  getScheduleById,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  toggleScheduleActive,
  Schedule,
} from "../appwrite/schedules.js";
import { scheduler } from "../scheduler/scheduler.js";
import { logger } from "../utils/logger.js";

// ─────────────────────────────────────────────
// VALIDATION SCHEMAS
// ─────────────────────────────────────────────

const createScheduleSchema = z.object({
  name: z.string().min(1).max(100),
  site_slug: z.string().min(1),
  cron_expression: z.string().min(1),
  filters: z.record(z.unknown()).optional(),
  created_by: z.string().optional(),
});

const updateScheduleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  site_slug: z.string().min(1).optional(),
  cron_expression: z.string().min(1).optional(),
  filters: z.record(z.unknown()).optional(),
  is_active: z.boolean().optional(),
});

// ─────────────────────────────────────────────
// VALID CRON EXPRESSIONS
// ─────────────────────────────────────────────

const VALID_CRON_PRESETS = [
  "0 6 * * *",      // Daily at 6 AM
  "0 0 * * *",      // Daily at midnight
  "0 */12 * * *",   // Every 12 hours
  "0 */6 * * *",    // Every 6 hours
  "0 6 * * 0",      // Weekly on Sunday
];

// ─────────────────────────────────────────────
// ROUTER
// ─────────────────────────────────────────────

export const schedulesRouter = Router();

// ─────────────────────────────────────────────
// GET /api/schedules - List all schedules
// ─────────────────────────────────────────────

schedulesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const schedules = await getAllSchedules();
    
    // Add scheduler status to each schedule
    const schedulesWithStatus = schedules.map((schedule) => ({
      ...schedule,
      is_scheduled: scheduler.getStatus().jobs.some((j) => j.id === schedule.$id),
    }));

    res.json({
      schedules: schedulesWithStatus,
      total: schedules.length,
      presets: VALID_CRON_PRESETS,
    });
  } catch (error) {
    logger.error("Failed to list schedules", { error });
    res.status(500).json({
      error: "Failed to list schedules",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ─────────────────────────────────────────────
// GET /api/schedules/:id - Get a specific schedule
// ─────────────────────────────────────────────

schedulesRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const schedule = await getScheduleById(req.params.id);
    
    if (!schedule) {
      res.status(404).json({
        error: "Schedule not found",
        message: `No schedule found with ID: ${req.params.id}`,
      });
      return;
    }

    res.json({ schedule });
  } catch (error) {
    logger.error("Failed to get schedule", { error, scheduleId: req.params.id });
    res.status(500).json({
      error: "Failed to get schedule",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ─────────────────────────────────────────────
// POST /api/schedules - Create a new schedule
// ─────────────────────────────────────────────

schedulesRouter.post("/", async (req: Request, res: Response) => {
  try {
    // Validate request body
    const parseResult = createScheduleSchema.safeParse(req.body);
    
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues,
      });
      return;
    }

    const { name, site_slug, cron_expression, filters, created_by } = parseResult.data;

    // Create schedule in database
    const schedule = await createSchedule({
      name,
      site_slug,
      cron_expression,
      filters,
      created_by,
    });

    if (!schedule) {
      res.status(500).json({
        error: "Failed to create schedule",
        message: "Schedule creation returned null",
      });
      return;
    }

    // Add to scheduler if active
    await scheduler.addOrUpdateSchedule(schedule);

    logger.info(`Schedule created: ${name}`, { scheduleId: schedule.$id });

    res.status(201).json({
      schedule,
      message: `Schedule "${name}" created successfully`,
    });
  } catch (error) {
    logger.error("Failed to create schedule", { error });
    res.status(500).json({
      error: "Failed to create schedule",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ─────────────────────────────────────────────
// PUT /api/schedules/:id - Update a schedule
// ─────────────────────────────────────────────

schedulesRouter.put("/:id", async (req: Request, res: Response) => {
  try {
    // Check if schedule exists
    const existing = await getScheduleById(req.params.id);
    
    if (!existing) {
      res.status(404).json({
        error: "Schedule not found",
        message: `No schedule found with ID: ${req.params.id}`,
      });
      return;
    }

    // Validate request body
    const parseResult = updateScheduleSchema.safeParse(req.body);
    
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues,
      });
      return;
    }

    const { name, site_slug, cron_expression, filters, is_active } = parseResult.data;

    // Update schedule in database
    const schedule = await updateSchedule(req.params.id, {
      name,
      site_slug,
      cron_expression,
      filters,
      is_active,
    });

    if (!schedule) {
      res.status(500).json({
        error: "Failed to update schedule",
        message: "Schedule update returned null",
      });
      return;
    }

    // Update scheduler
    await scheduler.addOrUpdateSchedule(schedule);

    logger.info(`Schedule updated: ${req.params.id}`);

    res.json({
      schedule,
      message: "Schedule updated successfully",
    });
  } catch (error) {
    logger.error("Failed to update schedule", { error, scheduleId: req.params.id });
    res.status(500).json({
      error: "Failed to update schedule",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ─────────────────────────────────────────────
// PATCH /api/schedules/:id/toggle - Toggle schedule active status
// ─────────────────────────────────────────────

schedulesRouter.patch("/:id/toggle", async (req: Request, res: Response) => {
  try {
    const schedule = await getScheduleById(req.params.id);
    
    if (!schedule) {
      res.status(404).json({
        error: "Schedule not found",
        message: `No schedule found with ID: ${req.params.id}`,
      });
      return;
    }

    const newActiveState = !schedule.is_active;
    
    await toggleScheduleActive(req.params.id, newActiveState);
    await scheduler.addOrUpdateSchedule({ ...schedule, is_active: newActiveState });

    logger.info(`Schedule ${req.params.id} ${newActiveState ? "enabled" : "disabled"}`);

    res.json({
      message: `Schedule ${newActiveState ? "enabled" : "disabled"}`,
      is_active: newActiveState,
    });
  } catch (error) {
    logger.error("Failed to toggle schedule", { error, scheduleId: req.params.id });
    res.status(500).json({
      error: "Failed to toggle schedule",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ─────────────────────────────────────────────
// POST /api/schedules/:id/trigger - Trigger a schedule immediately
// ─────────────────────────────────────────────

schedulesRouter.post("/:id/trigger", async (req: Request, res: Response) => {
  try {
    const result = await scheduler.triggerNow(req.params.id);
    
    if (!result.success) {
      res.status(404).json({
        error: "Schedule not found",
        message: result.message,
      });
      return;
    }

    logger.info(`Schedule triggered manually: ${req.params.id}`);

    res.json({
      message: result.message,
      triggered_at: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Failed to trigger schedule", { error, scheduleId: req.params.id });
    res.status(500).json({
      error: "Failed to trigger schedule",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/schedules/:id - Delete a schedule
// ─────────────────────────────────────────────

schedulesRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    // Check if schedule exists
    const schedule = await getScheduleById(req.params.id);
    
    if (!schedule) {
      res.status(404).json({
        error: "Schedule not found",
        message: `No schedule found with ID: ${req.params.id}`,
      });
      return;
    }

    // Remove from scheduler first
    scheduler.unscheduleJob(req.params.id);

    // Delete from database
    const deleted = await deleteSchedule(req.params.id);
    
    if (!deleted) {
      res.status(500).json({
        error: "Failed to delete schedule",
        message: "Delete operation returned false",
      });
      return;
    }

    logger.info(`Schedule deleted: ${req.params.id}`);

    res.json({
      message: `Schedule "${schedule.name}" deleted successfully`,
      deleted_id: req.params.id,
    });
  } catch (error) {
    logger.error("Failed to delete schedule", { error, scheduleId: req.params.id });
    res.status(500).json({
      error: "Failed to delete schedule",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ─────────────────────────────────────────────
// GET /api/schedules/status - Get scheduler status
// ─────────────────────────────────────────────

schedulesRouter.get("/status", (_req: Request, res: Response) => {
  const status = scheduler.getStatus();
  
  res.json({
    ...status,
    server_time: new Date().toISOString(),
  });
});