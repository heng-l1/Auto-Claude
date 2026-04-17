/**
 * Tests for auto-pr-review-service.ts
 *
 * Unit tests for AutoPRReviewService singleton covering:
 * - Singleton pattern (getInstance / resetInstance)
 * - enableForProject (5-min setInterval, immediate first poll, timer dedup on re-enable)
 * - disableForProject (clears timer, removes context)
 * - pollForEligiblePRs (fetch args, filters drafts/reviewed/running, sequential execution, pause-skip)
 * - Rate limit handling (403 / 'rate limit' -> pause -> 15-min resume)
 * - setMainWindowGetter (stored; polling null-safe when getter returns null)
 * - stopAll (clears all project timers + rateLimitResumeTimeout + resets pause flag)
 *
 * Mirrors the structure of pr-status-poller.test.ts. Mock vars declared outside
 * vi.mock() factories to work around Vitest hoisting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../shared/types';
import { AutoPRReviewService } from '../auto-pr-review-service';

// ---------------------------------------------------------------------------
// Mocks — all backing vars declared OUTSIDE vi.mock() factories.
// Vitest hoists vi.mock() above top-level `const` declarations, so factories
// must reference the outer vars lazily (via arrow wrappers or inside a
// constructor body).
// ---------------------------------------------------------------------------

const mockFetchPRsFromGraphQL = vi.fn();
const mockGetReviewResult = vi.fn();
const mockRunPRReview = vi.fn();
const mockIsReviewRunning = vi.fn();

vi.mock('../../ipc-handlers/github/pr-handlers', () => ({
  fetchPRsFromGraphQL: (...args: unknown[]) => mockFetchPRsFromGraphQL(...args),
  getReviewResult: (...args: unknown[]) => mockGetReviewResult(...args),
  runPRReview: (...args: unknown[]) => mockRunPRReview(...args),
  isReviewRunning: (...args: unknown[]) => mockIsReviewRunning(...args),
}));

// Class mock: the constructor body only runs on `new`, so the outer-var
// reference is deferred until after hoisting settles.
const mockPRReviewStateManager = vi.fn();
vi.mock('../../pr-review-state-manager', () => ({
  PRReviewStateManager: class MockPRReviewStateManager {
    constructor(...args: unknown[]) {
      mockPRReviewStateManager(...args);
    }
  },
}));

const mockNotifyPRReviewComplete = vi.fn();
vi.mock('../../notification-service', () => ({
  notificationService: {
    notifyPRReviewComplete: (...args: unknown[]) =>
      mockNotifyPRReviewComplete(...args),
  },
}));

// ---------------------------------------------------------------------------
// Constants (mirror auto-pr-review-service.ts literals)
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 300_000
const RATE_LIMIT_PAUSE_MS = 15 * 60 * 1000; // 900_000

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal Project fixture — only fields touched by AutoPRReviewService. */
function makeProject(id = 'p1'): Project {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    autoBuildPath: '.auto-claude',
    settings: {
      model: 'sonnet',
      memoryBackend: 'file',
      linearSync: false,
      graphitiMcpEnabled: false,
      notifications: {
        onTaskComplete: true,
        onTaskFailed: true,
        onReviewNeeded: true,
        onPRReviewComplete: true,
        onClaudeSessionComplete: true,
        sound: false,
      },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Minimal PR fixture matching the relevant fields of PRData. */
function makePR(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    title: `PR ${number}`,
    body: '',
    state: 'open',
    author: { login: 'user' },
    headRefName: 'feature',
    baseRefName: 'main',
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    assignees: [],
    files: [],
    createdAt: '',
    updatedAt: '',
    htmlUrl: '',
    isDraft: false,
    ...overrides,
  };
}

/** Deferred promise helper for controlling async mocks (sequential-execution test). */
function makeDeferred<T = unknown>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
} {
  let resolveFn!: (v: T) => void;
  let rejectFn!: (err: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

/** Fake main window; only `webContents.send` is ever touched in this scope. */
const mockMainWindow = {
  webContents: { send: vi.fn() },
};
const makeGetter = () =>
  vi.fn(() => mockMainWindow as unknown as Electron.BrowserWindow);

// ---------------------------------------------------------------------------

describe('AutoPRReviewService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    AutoPRReviewService.resetInstance();

    // Reset mocks
    mockFetchPRsFromGraphQL.mockReset();
    mockGetReviewResult.mockReset();
    mockRunPRReview.mockReset();
    mockIsReviewRunning.mockReset();
    mockPRReviewStateManager.mockReset();
    mockNotifyPRReviewComplete.mockReset();
    mockMainWindow.webContents.send.mockReset();

    // Sensible defaults for the happy path
    mockFetchPRsFromGraphQL.mockResolvedValue({
      prs: [],
      hasNextPage: false,
      endCursor: null,
    });
    mockGetReviewResult.mockReturnValue(null);
    mockIsReviewRunning.mockReturnValue(false);
    mockRunPRReview.mockResolvedValue({
      prNumber: 1,
      overallStatus: 'approved',
    });

    // Silence service's pre-existing console output (auto-pr-review-service.ts
    // still uses console.log at lines 143, 236, 286, 300, 347 — pre-existing
    // and out of scope per implementation_plan.json:subtask-3-1 notes).
    // biome-ignore lint/suspicious/noEmptyBlockStatements: mock implementation intentionally empty
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // biome-ignore lint/suspicious/noEmptyBlockStatements: mock implementation intentionally empty
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // biome-ignore lint/suspicious/noEmptyBlockStatements: mock implementation intentionally empty
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    AutoPRReviewService.resetInstance();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Singleton Pattern
  // =========================================================================
  describe('Singleton Pattern', () => {
    it('getInstance returns the same reference on multiple calls', () => {
      const a = AutoPRReviewService.getInstance();
      const b = AutoPRReviewService.getInstance();
      expect(a).toBe(b);
    });

    it('resetInstance creates a new instance; old timers cleared', async () => {
      const first = AutoPRReviewService.getInstance();
      first.setMainWindowGetter(makeGetter());
      first.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(first.isEnabledForProject('p1')).toBe(true);

      AutoPRReviewService.resetInstance();
      const second = AutoPRReviewService.getInstance();
      expect(first).not.toBe(second);
      // Fresh instance has no projects enabled
      expect(second.isEnabledForProject('p1')).toBe(false);

      // Old timer is gone — advancing does not invoke fetch again
      const callsAfterReset = mockFetchPRsFromGraphQL.mock.calls.length;
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
      expect(mockFetchPRsFromGraphQL.mock.calls.length).toBe(callsAfterReset);
    });
  });

  // =========================================================================
  // 2. enableForProject
  // =========================================================================
  describe('enableForProject', () => {
    it('starts a 5-minute (300_000ms) setInterval and triggers an immediate first poll', async () => {
      const svc = AutoPRReviewService.getInstance();
      svc.setMainWindowGetter(makeGetter());
      svc.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });

      // Immediate first poll fires synchronously (fire-and-forget async call);
      // flush microtasks so the awaited fetch promise resolves.
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchPRsFromGraphQL).toHaveBeenCalledTimes(1);

      // Advance just BELOW the interval — no second poll yet.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
      expect(mockFetchPRsFromGraphQL).toHaveBeenCalledTimes(1);

      // Crossing the 300_000ms boundary fires the next tick.
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFetchPRsFromGraphQL).toHaveBeenCalledTimes(2);

      expect(svc.isEnabledForProject('p1')).toBe(true);
    });

    it('replaces an existing timer when re-enabled for the same project (no duplicate timers)', async () => {
      const svc = AutoPRReviewService.getInstance();
      svc.setMainWindowGetter(makeGetter());

      // First enable → immediate poll (#1)
      svc.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchPRsFromGraphQL).toHaveBeenCalledTimes(1);

      // Second enable → disables first (clears old timer), starts new timer
      // with its own immediate poll (#2). If the old timer had leaked, the
      // upcoming interval advance would produce 2 extra ticks instead of 1.
      svc.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchPRsFromGraphQL).toHaveBeenCalledTimes(2);

      // Advance EXACTLY one interval — only one fresh tick expected if old
      // timer was correctly cleared.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(mockFetchPRsFromGraphQL).toHaveBeenCalledTimes(3);
    });
  });

  // =========================================================================
  // 3. disableForProject
  // =========================================================================
  describe('disableForProject', () => {
    it('clears the polling timer, removes context, and isEnabledForProject returns false', async () => {
      const svc = AutoPRReviewService.getInstance();
      svc.setMainWindowGetter(makeGetter());
      svc.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(svc.isEnabledForProject('p1')).toBe(true);

      const callsBeforeDisable = mockFetchPRsFromGraphQL.mock.calls.length;
      svc.disableForProject('p1');

      expect(svc.isEnabledForProject('p1')).toBe(false);

      // No further poll calls after disable.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
      expect(mockFetchPRsFromGraphQL.mock.calls.length).toBe(
        callsBeforeDisable
      );
    });

    it('is a no-op when the project was never enabled', () => {
      const svc = AutoPRReviewService.getInstance();
      expect(() => svc.disableForProject('never-enabled')).not.toThrow();
      expect(svc.isEnabledForProject('never-enabled')).toBe(false);
    });
  });

  // =========================================================================
  // 4. pollForEligiblePRs
  // =========================================================================
  describe('pollForEligiblePRs', () => {
    it('calls fetchPRsFromGraphQL with {token, repo}, null cursor, and "auto-review" context', async () => {
      const svc = AutoPRReviewService.getInstance();
      svc.setMainWindowGetter(makeGetter());
      svc.enableForProject('p1', makeProject('p1'), {
        token: 'test-token',
        repo: 'owner/repo',
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetchPRsFromGraphQL).toHaveBeenCalledWith(
        { token: 'test-token', repo: 'owner/repo' },
        null,
        'auto-review'
      );
    });

    it('filters out draft PRs', async () => {
      mockFetchPRsFromGraphQL.mockResolvedValue({
        prs: [makePR(1, { isDraft: true })],
        hasNextPage: false,
        endCursor: null,
      });

      const svc = AutoPRReviewService.getInstance();
      svc.setMainWindowGetter(makeGetter());
      svc.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });
      // Flush chain: fetch → filter → (queue empty path)
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRunPRReview).not.toHaveBeenCalled();
    });

    it('filters out PRs whose state is not "open"', async () => {
      mockFetchPRsFromGraphQL.mockResolvedValue({
        prs: [makePR(1, { state: 'closed' })],
        hasNextPage: false,
        endCursor: null,
      });

      const svc = AutoPRReviewService.getInstance();
      svc.setMainWindowGetter(makeGetter());
      svc.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRunPRReview).not.toHaveBeenCalled();
    });

    it('filters out PRs with an existing review result on disk', async () => {
      mockFetchPRsFromGraphQL.mockResolvedValue({
        prs: [makePR(1)],
        hasNextPage: false,
        endCursor: null,
      });
      mockGetReviewResult.mockReturnValue({
        prNumber: 1,
        overallStatus: 'approved',
      });

      const svc = AutoPRReviewService.getInstance();
      svc.setMainWindowGetter(makeGetter());
      svc.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRunPRReview).not.toHaveBeenCalled();
    });

    it('filters out PRs where isReviewRunning returns true', async () => {
      mockFetchPRsFromGraphQL.mockResolvedValue({
        prs: [makePR(1)],
        hasNextPage: false,
        endCursor: null,
      });
      mockIsReviewRunning.mockReturnValue(true);

      const svc = AutoPRReviewService.getInstance();
      svc.setMainWindowGetter(makeGetter());
      svc.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRunPRReview).not.toHaveBeenCalled();
    });

    it('queues eligible PRs and processes them sequentially via runPRReview', async () => {
      mockFetchPRsFromGraphQL.mockResolvedValue({
        prs: [makePR(1), makePR(2)],
        hasNextPage: false,
        endCursor: null,
      });

      // Deferred promises so we can observe "one-review-at-a-time" behavior.
      const d1 = makeDeferred<{ prNumber: number; overallStatus: string }>();
      const d2 = makeDeferred<{ prNumber: number; overallStatus: string }>();
      mockRunPRReview
        .mockReturnValueOnce(d1.promise)
        .mockReturnValueOnce(d2.promise);

      const svc = AutoPRReviewService.getInstance();
      svc.setMainWindowGetter(makeGetter());
      svc.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });

      // Drain enough microtasks for pollForEligiblePRs → processReviewQueue
      // to kick off the first review.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRunPRReview).toHaveBeenCalledTimes(1);
      expect(mockRunPRReview).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ id: 'p1' }),
        1,
        expect.anything(),
        expect.anything()
      );

      // Second review must NOT start while the first is pending.
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRunPRReview).toHaveBeenCalledTimes(1);

      // Resolve first → second starts.
      d1.resolve({ prNumber: 1, overallStatus: 'approved' });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRunPRReview).toHaveBeenCalledTimes(2);
      expect(mockRunPRReview).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ id: 'p1' }),
        2,
        expect.anything(),
        expect.anything()
      );

      d2.resolve({ prNumber: 2, overallStatus: 'approved' });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // Completion notification fired per review.
      expect(mockNotifyPRReviewComplete).toHaveBeenCalledTimes(2);
      expect(mockNotifyPRReviewComplete).toHaveBeenCalledWith(1, 'p1');
      expect(mockNotifyPRReviewComplete).toHaveBeenCalledWith(2, 'p1');
    });

    it('skips polling when isPausedForRateLimit is true (set via a prior 403)', async () => {
      // First poll rejects with 403 → pauses service
      mockFetchPRsFromGraphQL.mockRejectedValueOnce(
        new Error('403 rate limit exceeded')
      );

      const svc = AutoPRReviewService.getInstance();
      svc.setMainWindowGetter(makeGetter());
      svc.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });
      await vi.advanceTimersByTimeAsync(0);

      // Subsequent 5-min tick should short-circuit on the pause flag and
      // never reach fetchPRsFromGraphQL again.
      const callsAfterPause = mockFetchPRsFromGraphQL.mock.calls.length;
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(mockFetchPRsFromGraphQL.mock.calls.length).toBe(callsAfterPause);
    });
  });

  // =========================================================================
  // 5. Rate Limit Handling
  // =========================================================================
  describe('Rate Limit Handling', () => {
    it('triggers pauseForRateLimit on a 403 error from fetchPRsFromGraphQL', async () => {
      mockFetchPRsFromGraphQL.mockRejectedValueOnce(
        new Error('403 Forbidden')
      );

      const svc = AutoPRReviewService.getInstance();
      svc.setMainWindowGetter(makeGetter());
      svc.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });
      await vi.advanceTimersByTimeAsync(0);

      // Under pause: next scheduled tick is skipped.
      const callsBefore = mockFetchPRsFromGraphQL.mock.calls.length;
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(mockFetchPRsFromGraphQL.mock.calls.length).toBe(callsBefore);
    });

    it('triggers pauseForRateLimit on a generic "rate limit" error message', async () => {
      mockFetchPRsFromGraphQL.mockRejectedValueOnce(
        new Error('secondary rate limit triggered')
      );

      const svc = AutoPRReviewService.getInstance();
      svc.setMainWindowGetter(makeGetter());
      svc.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });
      await vi.advanceTimersByTimeAsync(0);

      const callsBefore = mockFetchPRsFromGraphQL.mock.calls.length;
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(mockFetchPRsFromGraphQL.mock.calls.length).toBe(callsBefore);
    });

    it('schedules resume after RATE_LIMIT_PAUSE_MS (900_000ms); pause persists until then', async () => {
      mockFetchPRsFromGraphQL.mockRejectedValueOnce(
        new Error('403 rate limit')
      );

      const svc = AutoPRReviewService.getInstance();
      svc.setMainWindowGetter(makeGetter());
      svc.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });
      await vi.advanceTimersByTimeAsync(0);

      // Any subsequent fetch calls would be the successful (default) mock.
      const callsAtPauseStart = mockFetchPRsFromGraphQL.mock.calls.length;

      // Advance just below the pause window — 2 poll ticks (at 5 and 10 min)
      // should have been skipped because of the pause flag.
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_PAUSE_MS - 1);
      expect(mockFetchPRsFromGraphQL.mock.calls.length).toBe(callsAtPauseStart);
    });

    it('resumes polling after 15 minutes: the next poll executes normally', async () => {
      mockFetchPRsFromGraphQL.mockRejectedValueOnce(
        new Error('403 rate limit')
      );

      const svc = AutoPRReviewService.getInstance();
      svc.setMainWindowGetter(makeGetter());
      svc.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });
      await vi.advanceTimersByTimeAsync(0);

      const callsAtPauseStart = mockFetchPRsFromGraphQL.mock.calls.length;

      // Advance past the 15-min pause window + one more interval tick so the
      // resume timeout fires AND an interval tick runs with pause cleared.
      await vi.advanceTimersByTimeAsync(
        RATE_LIMIT_PAUSE_MS + POLL_INTERVAL_MS
      );

      // Fresh poll must have happened after pause cleared.
      expect(mockFetchPRsFromGraphQL.mock.calls.length).toBeGreaterThan(
        callsAtPauseStart
      );
    });
  });

  // =========================================================================
  // 6. setMainWindowGetter
  // =========================================================================
  describe('setMainWindowGetter', () => {
    it('stores the getter and invokes it when processing the review queue', async () => {
      mockFetchPRsFromGraphQL.mockResolvedValue({
        prs: [makePR(1)],
        hasNextPage: false,
        endCursor: null,
      });

      const getter = makeGetter();
      const svc = AutoPRReviewService.getInstance();
      svc.setMainWindowGetter(getter);
      svc.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // processReviewQueue reads main window through the stored getter.
      expect(getter).toHaveBeenCalled();
      // A PRReviewStateManager was constructed for the review.
      expect(mockPRReviewStateManager).toHaveBeenCalled();
    });

    it('does not throw when the getter returns null; review queue simply no-ops', async () => {
      mockFetchPRsFromGraphQL.mockResolvedValue({
        prs: [makePR(1)],
        hasNextPage: false,
        endCursor: null,
      });

      const nullGetter = vi.fn(() => null);
      const svc = AutoPRReviewService.getInstance();
      svc.setMainWindowGetter(nullGetter);

      expect(() =>
        svc.enableForProject('p1', makeProject('p1'), {
          token: 't',
          repo: 'o/r',
        })
      ).not.toThrow();

      // Draining microtasks must not raise.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // Because the getter returned null, processReviewQueue bails early —
      // no review actually runs.
      expect(mockRunPRReview).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 7. stopAll
  // =========================================================================
  describe('stopAll', () => {
    it('clears timers for every active project — no further polls fire', async () => {
      const svc = AutoPRReviewService.getInstance();
      svc.setMainWindowGetter(makeGetter());

      svc.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });
      svc.enableForProject('p2', makeProject('p2'), {
        token: 't',
        repo: 'o/r',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(svc.isEnabledForProject('p1')).toBe(true);
      expect(svc.isEnabledForProject('p2')).toBe(true);

      const callsBeforeStop = mockFetchPRsFromGraphQL.mock.calls.length;
      svc.stopAll();

      expect(svc.isEnabledForProject('p1')).toBe(false);
      expect(svc.isEnabledForProject('p2')).toBe(false);

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
      expect(mockFetchPRsFromGraphQL.mock.calls.length).toBe(callsBeforeStop);
    });

    it('clears rateLimitResumeTimeout and resets isPausedForRateLimit flag', async () => {
      // Trigger a pause so rateLimitResumeTimeout + pause flag are set.
      mockFetchPRsFromGraphQL.mockRejectedValueOnce(
        new Error('403 rate limit')
      );

      const svc = AutoPRReviewService.getInstance();
      svc.setMainWindowGetter(makeGetter());
      svc.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });
      await vi.advanceTimersByTimeAsync(0);

      // Sanity: pause is active — next tick skipped.
      const callsAtPause = mockFetchPRsFromGraphQL.mock.calls.length;
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(mockFetchPRsFromGraphQL.mock.calls.length).toBe(callsAtPause);

      // Now stop all: must clear resume timeout and reset the pause flag.
      svc.stopAll();

      // Advance past what would have been the 15-min resume boundary — the
      // resume timeout must NOT fire (no console.log "Resuming" from the
      // cleared timer), and re-enabling must not inherit a stale pause flag.
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_PAUSE_MS);

      // Re-enable with successful mock — if pause flag leaked, the new
      // immediate poll would skip and fetch would not be invoked.
      mockFetchPRsFromGraphQL.mockResolvedValue({
        prs: [],
        hasNextPage: false,
        endCursor: null,
      });
      svc.enableForProject('p1', makeProject('p1'), {
        token: 't',
        repo: 'o/r',
      });
      await vi.advanceTimersByTimeAsync(0);

      // Fetch happened immediately → pause flag was indeed reset.
      expect(mockFetchPRsFromGraphQL.mock.calls.length).toBeGreaterThan(
        callsAtPause
      );
    });
  });
});
