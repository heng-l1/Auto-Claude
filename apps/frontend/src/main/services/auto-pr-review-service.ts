/**
 * Auto PR Review Service
 *
 * Main process singleton service that polls for eligible PRs and automatically
 * triggers AI reviews on a 5-minute interval. Runs sequentially — one review
 * at a time per project — to avoid overloading the GitHub API.
 *
 * Features:
 * - 5-minute polling interval per project
 * - Sequential review queue (one review at a time)
 * - PR eligibility filtering (open, not draft, not already reviewed)
 * - Rate limit awareness (pauses when approaching limits)
 * - Duplicate review prevention
 *
 * @module auto-pr-review-service
 */

import type { BrowserWindow } from 'electron';
import type { Project } from '../../shared/types';
import {
  fetchPRsFromGraphQL,
  getReviewResult,
  runPRReview,
  isReviewRunning,
} from '../ipc-handlers/github/pr-handlers';
import { PRReviewStateManager } from '../pr-review-state-manager';
import { notificationService } from '../notification-service';

/** Polling interval: 5 minutes */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Rate limit pause duration: 15 minutes (conservative — rate limit resets hourly) */
const RATE_LIMIT_PAUSE_MS = 15 * 60 * 1000;

/**
 * Per-project review context
 */
interface ProjectReviewContext {
  /** Polling timer handle */
  timer: NodeJS.Timeout | null;
  /** Full Project object (needed by getReviewResult and runPRReview) */
  project: Project;
  /** GitHub API token */
  token: string;
  /** Repository in "owner/repo" format */
  repo: string;
  /** PR numbers awaiting review */
  reviewQueue: number[];
  /** Whether a review is currently in progress */
  isReviewing: boolean;
  /** Timestamp of last completed scan */
  lastScan: Date | null;
}

/**
 * AutoPRReviewService — Polls for eligible PRs and triggers AI reviews automatically
 *
 * Singleton service that manages per-project auto PR review polling.
 * When enabled for a project, it scans for new, non-draft, un-reviewed PRs
 * every 5 minutes and processes them sequentially (one at a time).
 *
 * Follows the same singleton pattern as PRStatusPoller.
 */
export class AutoPRReviewService {
  private static instance: AutoPRReviewService | null = null;

  /** Active review contexts by project ID */
  private contexts: Map<string, ProjectReviewContext> = new Map();

  /** Main window getter for creating state managers and passing to runPRReview */
  private getMainWindow: (() => BrowserWindow | null) | null = null;

  /** Rate limit tracking */
  private isPausedForRateLimit = false;
  private rateLimitResumeTimeout: NodeJS.Timeout | null = null;

  private constructor() {
    // Private constructor for singleton pattern
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): AutoPRReviewService {
    if (!AutoPRReviewService.instance) {
      AutoPRReviewService.instance = new AutoPRReviewService();
    }
    return AutoPRReviewService.instance;
  }

  /**
   * Reset the singleton instance (for testing)
   */
  static resetInstance(): void {
    if (AutoPRReviewService.instance) {
      AutoPRReviewService.instance.stopAll();
      AutoPRReviewService.instance = null;
    }
  }

  /**
   * Set the main window getter for IPC communication
   */
  setMainWindowGetter(getter: () => BrowserWindow | null): void {
    this.getMainWindow = getter;
  }

  /**
   * Enable auto PR review for a project
   *
   * Starts 5-minute polling for eligible PRs. Calls disableForProject first
   * to prevent duplicate timers on rapid toggle.
   *
   * @param projectId - Project identifier
   * @param project - Full Project object (needed by getReviewResult and runPRReview)
   * @param config - GitHub token and repo in "owner/repo" format
   */
  enableForProject(
    projectId: string,
    project: Project,
    config: { token: string; repo: string }
  ): void {
    // Prevent duplicate timers on rapid toggle
    this.disableForProject(projectId);

    const ctx: ProjectReviewContext = {
      timer: null,
      project,
      token: config.token,
      repo: config.repo,
      reviewQueue: [],
      isReviewing: false,
      lastScan: null,
    };

    // Start polling timer
    ctx.timer = setInterval(
      () => this.pollForEligiblePRs(projectId),
      POLL_INTERVAL_MS
    );
    this.contexts.set(projectId, ctx);

    console.log(
      `[AutoPRReview] Enabled for ${projectId}, polling every 5 minutes`
    );

    // Trigger immediate first poll
    this.pollForEligiblePRs(projectId);
  }

  /**
   * Disable auto PR review for a project
   */
  disableForProject(projectId: string): void {
    const ctx = this.contexts.get(projectId);
    if (ctx?.timer) {
      clearInterval(ctx.timer);
    }
    this.contexts.delete(projectId);
  }

  /**
   * Stop all polling across all projects (for app shutdown)
   */
  stopAll(): void {
    for (const projectId of Array.from(this.contexts.keys())) {
      this.disableForProject(projectId);
    }

    // Clear rate limit resume timeout
    if (this.rateLimitResumeTimeout) {
      clearTimeout(this.rateLimitResumeTimeout);
      this.rateLimitResumeTimeout = null;
    }

    this.isPausedForRateLimit = false;
  }

  /**
   * Check if auto review is enabled for a project
   */
  isEnabledForProject(projectId: string): boolean {
    return this.contexts.has(projectId);
  }

  /**
   * Poll for eligible PRs and queue them for review
   */
  private async pollForEligiblePRs(projectId: string): Promise<void> {
    const ctx = this.contexts.get(projectId);
    if (!ctx) return;

    // Skip if paused for rate limiting
    if (this.isPausedForRateLimit) {
      return;
    }

    try {
      // Fetch open PRs using the existing GraphQL query
      const result = await fetchPRsFromGraphQL(
        { token: ctx.token, repo: ctx.repo },
        null,
        'auto-review'
      );

      ctx.lastScan = new Date();

      // Filter for eligible PRs: open, not draft, no existing review, not currently running
      const eligiblePRs: number[] = [];

      for (const pr of result.prs) {
        // Only open PRs (mapGraphQLPRToData lowercases the state)
        if (pr.state !== 'open') continue;

        // Skip drafts
        if (pr.isDraft) continue;

        // Skip PRs with existing review results on disk
        const existingReview = getReviewResult(ctx.project, pr.number);
        if (existingReview !== null) continue;

        // Skip PRs that are currently being reviewed
        if (isReviewRunning(projectId, pr.number)) continue;

        eligiblePRs.push(pr.number);
      }

      if (eligiblePRs.length > 0) {
        // Add to queue (avoid duplicates)
        for (const prNumber of eligiblePRs) {
          if (!ctx.reviewQueue.includes(prNumber)) {
            ctx.reviewQueue.push(prNumber);
          }
        }

        console.log(
          `[AutoPRReview] Found ${eligiblePRs.length} eligible PRs for ${projectId}: ${eligiblePRs.join(', ')}`
        );

        // Start processing the queue
        this.processReviewQueue(projectId);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';

      // Check for rate limit issues
      if (message.includes('403') || message.includes('rate limit')) {
        this.pauseForRateLimit();
      }

      console.error(
        `[AutoPRReview] Error polling PRs for ${projectId}: ${message}`
      );
    }
  }

  /**
   * Process the review queue sequentially — one review at a time per project
   */
  private async processReviewQueue(projectId: string): Promise<void> {
    const ctx = this.contexts.get(projectId);
    if (!ctx || ctx.isReviewing || ctx.reviewQueue.length === 0) return;

    const mainWindow = this.getMainWindow?.();
    if (!mainWindow) return;

    ctx.isReviewing = true;

    try {
      while (ctx.reviewQueue.length > 0) {
        // Check if still enabled (could have been disabled during a review)
        if (!this.contexts.has(projectId)) break;

        // Check rate limit
        if (this.isPausedForRateLimit) break;

        const prNumber = ctx.reviewQueue.shift()!;

        // Double-check eligibility before starting (PR state may have changed)
        if (isReviewRunning(projectId, prNumber)) continue;
        const existingReview = getReviewResult(ctx.project, prNumber);
        if (existingReview !== null) continue;

        try {
          console.log(
            `[AutoPRReview] Starting review for PR #${prNumber} in ${projectId}`
          );

          // Create a state manager for this review
          // (follows GITHUB_PR_RUN_REVIEW handler pattern)
          const stateManager = new PRReviewStateManager(this.getMainWindow!);

          // Run the review
          await runPRReview(ctx.project, prNumber, mainWindow, stateManager);

          // Notify completion via activity center
          notificationService.notifyPRReviewComplete(prNumber, projectId);

          console.log(
            `[AutoPRReview] Completed review for PR #${prNumber} in ${projectId}`
          );
        } catch (reviewError) {
          const message =
            reviewError instanceof Error
              ? reviewError.message
              : 'Unknown error';
          console.error(
            `[AutoPRReview] Error reviewing PR #${prNumber} in ${projectId}: ${message}`
          );

          // Pause on rate limit errors; continue queue on other errors
          if (message.includes('403') || message.includes('rate limit')) {
            this.pauseForRateLimit();
            break;
          }
        }
      }
    } finally {
      ctx.isReviewing = false;
    }
  }

  /**
   * Pause polling due to rate limit concerns
   *
   * Follows the PRStatusPoller pattern: sets a flag checked by polling methods
   * and schedules automatic resume after a conservative delay.
   */
  private pauseForRateLimit(): void {
    if (this.isPausedForRateLimit) return;

    this.isPausedForRateLimit = true;
    console.warn(
      '[AutoPRReview] Pausing auto-review due to rate limit concerns'
    );

    // Clear any existing resume timeout
    if (this.rateLimitResumeTimeout) {
      clearTimeout(this.rateLimitResumeTimeout);
    }

    // Schedule resume after conservative delay
    this.rateLimitResumeTimeout = setTimeout(() => {
      this.isPausedForRateLimit = false;
      this.rateLimitResumeTimeout = null;
      console.log('[AutoPRReview] Resuming auto-review after rate limit pause');
    }, RATE_LIMIT_PAUSE_MS);
  }
}
