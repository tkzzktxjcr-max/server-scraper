import { runScraper, ScrapeParams, ScraperSource } from "../scrapers/index.js";
import { isHttpScraperSource, runHttpScraper, HttpScraperSource } from "../scrapers/http-dispatcher.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";

// ─────────────────────────────────────────────
// TYPE DEFINITIONS
// ─────────────────────────────────────────────

interface QueuedJob {
  params: ScrapeParams;
  addedAt: number;
}

export interface QueueJobParams {
  jobId: string;
  source: ScraperSource | HttpScraperSource;
  siteSlug?: string;
  filters?: Record<string, unknown>;
  trigger: "manual" | "agent" | "scheduled" | "realtime";
}

// ─────────────────────────────────────────────
// JOB QUEUE CLASS
// ─────────────────────────────────────────────

class JobQueue {
  private queue: QueuedJob[] = [];
  private running: Set<string> = new Set();
  private maxConcurrent: number;
  private processorInterval: NodeJS.Timeout | null = null;

  constructor(maxConcurrent: number = config.rateLimit.maxConcurrentJobs) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Add a job to the queue
   */
  add(params: QueueJobParams): void {
    const isQueued = this.queue.some((q) => q.params.jobId === params.jobId);
    const isRunning = this.running.has(params.jobId);

    if (isQueued || isRunning) {
      logger.warn(`Job ${params.jobId} is already queued or running`);
      return;
    }

    const scrapeParams: ScrapeParams = {
      jobId: params.jobId,
      source: params.source as ScraperSource,
      filters: params.filters,
    };

    this.queue.push({
      params: scrapeParams,
      addedAt: Date.now(),
    });

    logger.info(`Job ${params.jobId} added to queue`, {
      source: params.source,
      httpMode: isHttpScraperSource(params.source),
      trigger: params.trigger,
      queueSize: this.queue.length,
    });

    if (!this.processorInterval) {
      this.start();
    }
  }

  /**
   * Process the next job — dispatches to HTTP or Playwright scraper
   */
  private async processNext(): Promise<void> {
    if (this.running.size >= this.maxConcurrent) return;

    const job = this.queue.shift();
    if (!job) return;

    this.running.add(job.params.jobId);

    logger.info(`Starting job ${job.params.jobId}`, {
      source: job.params.source,
      httpMode: isHttpScraperSource(job.params.source),
      running: this.running.size,
      queued: this.queue.length,
    });

    try {
      // ── Dispatch: HTTP scrapers bypass Playwright ──
      if (isHttpScraperSource(job.params.source)) {
        await runHttpScraper({
          jobId: job.params.jobId,
          source: job.params.source as HttpScraperSource,
          filters: job.params.filters,
        });
      } else {
        // Fallback to Playwright-based scraper
        await runScraper(job.params);
      }
    } catch (error) {
      logger.error(`Job ${job.params.jobId} failed`, { error });
    } finally {
      this.running.delete(job.params.jobId);
    }
  }

  private start(): void {
    if (this.processorInterval) return;

    this.processorInterval = setInterval(async () => {
      while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
        await this.processNext();
      }
      if (this.queue.length === 0 && this.running.size === 0) {
        this.stop();
      }
    }, 1000);
  }

  private stop(): void {
    if (this.processorInterval) {
      clearInterval(this.processorInterval);
      this.processorInterval = null;
    }
  }

  getStatus(): { running: number; queued: number } {
    return { running: this.running.size, queued: this.queue.length };
  }

  isJobRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  isJobQueued(jobId: string): boolean {
    return this.queue.some((q) => q.params.jobId === jobId);
  }

  getQueuedJobs(): Array<{ jobId: string; addedAt: number }> {
    return this.queue.map((q) => ({ jobId: q.params.jobId, addedAt: q.addedAt }));
  }
}

export const jobQueue = new JobQueue();