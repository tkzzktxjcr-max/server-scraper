import cron, { ScheduledTask } from "node-cron";
import { v4 as uuidv4 } from "uuid";
import {
  getAllSchedules,
  getScheduleById,
  updateScheduleLastRun,
  Schedule,
} from "../appwrite/schedules.js";
import { createJob } from "../appwrite/client.js";
import { getSiteBySlug } from "../appwrite/client.js";
import { jobQueue } from "../jobs/queue.js";
import { logger } from "../utils/logger.js";

// ─────────────────────────────────────────────
// TYPE DEFINITIONS
// ─────────────────────────────────────────────

interface ScheduledTaskEntry {
  schedule: Schedule;
  task: ScheduledTask;
}

// ─────────────────────────────────────────────
// SCHEDULER CLASS
// ─────────────────────────────────────────────

class Scheduler {
  private tasks: Map<string, ScheduledTaskEntry> = new Map();
  private isInitialized = false;

  /**
   * Initialize the scheduler by loading all active schedules from Appwrite
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn("Scheduler already initialized");
      return;
    }

    logger.info("Initializing scheduler...");

    try {
      const schedules = await getAllSchedules();
      
      for (const schedule of schedules) {
        if (schedule.is_active) {
          this.scheduleJob(schedule);
        }
      }

      this.isInitialized = true;
      logger.info(`Scheduler initialized with ${this.tasks.size} active schedules`);
    } catch (error) {
      logger.error("Failed to initialize scheduler", { error });
      throw error;
    }
  }

  /**
   * Schedule a job based on a schedule configuration
   */
  private scheduleJob(schedule: Schedule): void {
    // Validate cron expression
    if (!cron.validate(schedule.cron_expression)) {
      logger.error(`Invalid cron expression for schedule ${schedule.$id}: ${schedule.cron_expression}`);
      return;
    }

    // Remove existing task if any
    this.unscheduleJob(schedule.$id);

    // Create a new scheduled task
    const task = cron.schedule(schedule.cron_expression, async () => {
      await this.executeScheduledJob(schedule);
    }, {
      scheduled: true,
      timezone: "Europe/Brussels", // Belgian timezone
    });

    this.tasks.set(schedule.$id, { schedule, task });
    logger.info(`Scheduled job: ${schedule.name} (${schedule.cron_expression})`, { scheduleId: schedule.$id });
  }

  /**
   * Execute a scheduled job
   */
  private async executeScheduledJob(schedule: Schedule): Promise<void> {
    const runId = uuidv4();
    const startedAt = new Date().toISOString();

    logger.info(`Executing scheduled job: ${schedule.name}`, {
      scheduleId: schedule.$id,
      runId,
      siteSlug: schedule.site_slug,
    });

    try {
      // Get site by slug
      const site = await getSiteBySlug(schedule.site_slug);
      if (!site) {
        logger.error(`Site not found for schedule ${schedule.$id}: ${schedule.site_slug}`);
        return;
      }

      // Create a job in Appwrite
      const jobId = await createJob({
        siteId: site.$id,
        trigger: "scheduled",
        filters: schedule.filters,
        createdBy: `scheduler:${schedule.$id}`,
      });

      // Add to queue (without browser scraping, just job creation)
      // The queue processor will handle the actual scraping
      jobQueue.add({
        jobId,
        siteSlug: schedule.site_slug,
        filters: schedule.filters,
        trigger: "scheduled",
      });

      // Update schedule last run
      const nextRun = this.calculateNextRun(schedule.cron_expression);
      await updateScheduleLastRun(schedule.$id, startedAt, nextRun);

      logger.info(`Scheduled job completed: ${schedule.name}`, {
        scheduleId: schedule.$id,
        jobId,
        runId,
      });
    } catch (error) {
      logger.error(`Scheduled job failed: ${schedule.name}`, {
        scheduleId: schedule.$id,
        error,
      });
    }
  }

  /**
   * Calculate the next run time for a cron expression
   */
  private calculateNextRun(cronExpression: string): string {
    // Use a simple approach to get next occurrence
    const parts = cronExpression.split(" ");
    if (parts.length !== 5) {
      return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    }

    const [minute, hour, , ,] = parts;
    const now = new Date();
    const next = new Date(now);

    const targetMinute = minute === "*" ? now.getMinutes() : parseInt(minute, 10);
    const targetHour = hour === "*" ? now.getHours() : parseInt(hour, 10);

    next.setMinutes(targetMinute);
    next.setHours(targetHour);
    next.setSeconds(0);

    // If the time has passed today, schedule for tomorrow
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }

    return next.toISOString();
  }

  /**
   * Add or update a schedule
   */
  async addOrUpdateSchedule(schedule: Schedule): Promise<void> {
    if (schedule.is_active) {
      this.scheduleJob(schedule);
    } else {
      this.unscheduleJob(schedule.$id);
    }
  }

  /**
   * Remove a schedule from the scheduler
   */
  unscheduleJob(scheduleId: string): void {
    const entry = this.tasks.get(scheduleId);
    if (entry) {
      entry.task.stop();
      this.tasks.delete(scheduleId);
      logger.info(`Unscheduled job: ${scheduleId}`);
    }
  }

  /**
   * Trigger a schedule immediately (manual trigger)
   */
  async triggerNow(scheduleId: string): Promise<{ success: boolean; message: string }> {
    const schedule = await getScheduleById(scheduleId);
    
    if (!schedule) {
      return { success: false, message: "Schedule not found" };
    }

    logger.info(`Manual trigger for schedule: ${schedule.name}`, { scheduleId });

    // Execute immediately
    await this.executeScheduledJob(schedule);

    return { success: true, message: `Schedule "${schedule.name}" triggered successfully` };
  }

  /**
   * Get the status of all scheduled jobs
   */
  getStatus(): { activeJobs: number; jobs: Array<{ id: string; name: string; cron: string }> } {
    const jobs = Array.from(this.tasks.entries()).map(([id, entry]) => ({
      id,
      name: entry.schedule.name,
      cron: entry.schedule.cron_expression,
    }));

    return {
      activeJobs: this.tasks.size,
      jobs,
    };
  }

  /**
   * Refresh all schedules from the database
   */
  async refresh(): Promise<void> {
    logger.info("Refreshing scheduler schedules...");

    // Stop all current tasks
    for (const [id, entry] of this.tasks.entries()) {
      entry.task.stop();
    }
    this.tasks.clear();

    // Reload schedules from database
    const schedules = await getAllSchedules();
    
    for (const schedule of schedules) {
      if (schedule.is_active) {
        this.scheduleJob(schedule);
      }
    }

    logger.info(`Scheduler refreshed with ${this.tasks.size} active schedules`);
  }

  /**
   * Gracefully shutdown the scheduler
   */
  async shutdown(): Promise<void> {
    logger.info("Shutting down scheduler...");
    
    for (const [id, entry] of this.tasks.entries()) {
      entry.task.stop();
    }
    
    this.tasks.clear();
    this.isInitialized = false;
    
    logger.info("Scheduler shut down");
  }
}

// Singleton instance
export const scheduler = new Scheduler();

// ─────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────

/**
 * Get the next occurrence of a cron expression in human-readable format
 */
export function getNextOccurrence(cronExpression: string): string {
  const parts = cronExpression.split(" ");
  if (parts.length !== 5) return "Invalid cron expression";

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Simple parsing for common patterns
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    // Daily schedule
    const h = hour === "*" ? "every hour" : `${hour.padStart(2, "0")}`;
    const m = minute === "*" ? "every minute" : `${minute.padStart(2, "0")}`;
    
    if (hour === "*") {
      return `Every ${minute} minutes`;
    }
    return `Daily at ${h}:${m}`;
  }

  if (dayOfWeek !== "*" && dayOfMonth === "*") {
    // Weekly schedule
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const day = days[parseInt(dayOfWeek, 10)] || dayOfWeek;
    const h = hour === "*" ? "00" : hour.padStart(2, "0");
    const m = minute === "*" ? "00" : minute.padStart(2, "0");
    return `Weekly on ${day} at ${h}:${m}`;
  }

  return `At minute ${minute}, hour ${hour}`;
}