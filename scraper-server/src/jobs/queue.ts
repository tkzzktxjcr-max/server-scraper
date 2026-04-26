import { runScraper, ScrapeParams } from "../scrapers/index.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";

interface QueuedJob {
  params: ScrapeParams;
  addedAt: number;
}

class JobQueue {
  private queue: QueuedJob[] = [];
  private running: Set<string> = new Set();
  private maxConcurrent: number;
  private processorInterval: NodeJS.Timeout | null = null;

  constructor(maxConcurrent: number = config.rateLimit.maxConcurrentJobs) {
    this.maxConcurrent = maxConcurrent;
  }

  add(params: ScrapeParams): void {
    // Check if job already in queue or running
    const isQueued = this.queue.some((q) => q.params.jobId === params.jobId);
    const isRunning = this.running.has(params.jobId);

    if (isQueued || isRunning) {
      logger.warn(`Job ${params.jobId} is already queued or running`);
      return;
    }

    this.queue.push({
      params,
      addedAt: Date.now(),
    });

    logger.info(`Job ${params.jobId} added to queue`, { queueSize: this.queue.length });
    
    // Start processor if not running
    if (!this.processorInterval) {
      this.start();
    }
  }

  private async processNext(): Promise<void> {
    if (this.running.size >= this.maxConcurrent) {
      return; // Max concurrent jobs reached
    }

    const job = this.queue.shift();
    if (!job) {
      return; // Queue is empty
    }

    this.running.add(job.params.jobId);
    
    logger.info(`Starting job ${job.params.jobId}`, { 
      running: this.running.size,
      queued: this.queue.length 
    });

    // Run the scraper
    try {
      await runScraper(job.params);
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

      // Stop interval if queue is empty and no jobs running
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
    return {
      running: this.running.size,
      queued: this.queue.length,
    };
  }

  isJobRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  isJobQueued(jobId: string): boolean {
    return this.queue.some((q) => q.params.jobId === jobId);
  }
}

// Singleton instance
export const jobQueue = new JobQueue();
