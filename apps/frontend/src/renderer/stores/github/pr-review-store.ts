import { create } from 'zustand';
import type {
  PRReviewProgress,
  PRReviewResult,
  NewCommitsCheck,
  PRReviewStatePayload,
  ManualFindingsChangeReason
} from '../../../preload/api/modules/github-api';
import type {
  ChecksStatus,
  ReviewsStatus,
  MergeableState,
  PRStatusUpdate
} from '../../../shared/types/pr-status';
import type { ManualPRReviewFinding } from '../../../shared/types/pr-review-comments';

/**
 * PR review state for a single PR
 */
interface PRReviewState {
  prNumber: number;
  projectId: string;
  isReviewing: boolean;
  /** Timestamp when the review was started (ISO 8601 string) */
  startedAt: string | null;
  progress: PRReviewProgress | null;
  result: PRReviewResult | null;
  /** Previous review result - preserved during follow-up review for continuity */
  previousResult: PRReviewResult | null;
  error: string | null;
  /** Cached result of new commits check - updated when detail view checks */
  newCommitsCheck: NewCommitsCheck | null;
  /** CI checks status from polling */
  checksStatus: ChecksStatus | null;
  /** Review status from polling */
  reviewsStatus: ReviewsStatus | null;
  /** Mergeable state from polling */
  mergeableState: MergeableState | null;
  /** Timestamp of last status poll (ISO 8601 string) */
  lastPolled: string | null;
  /** Whether this review was initiated externally (e.g., from PR list) rather than from detail view */
  isExternalReview: boolean;
  /** User-provided reviewer notes for this PR (observations, focus areas, custom prompts) */
  notes: string;
}

interface PRReviewStoreState {
  // PR Review state - persists across navigation
  // Key: `${projectId}:${prNumber}`
  prReviews: Record<string, PRReviewState>;

  /**
   * Manually-authored PR review findings, keyed by PR number.
   * Populated lazily via `loadManualFindings` and kept in sync with the on-disk
   * `manual_findings_<prNumber>.json` files through the
   * `GITHUB_PR_MANUAL_FINDINGS_CHANGED` event listener (see
   * `initializePRReviewListeners`).
   */
  manualFindings: Record<number, ManualPRReviewFinding[]>;

  // XState state change handler
  handlePRReviewStateChange: (key: string, payload: PRReviewStatePayload) => void;

  // Kept actions (not managed by XState)
  /** Load a review result from disk into the store (not triggered by XState) */
  setLoadedReviewResult: (projectId: string, result: PRReviewResult, options?: { preserveNewCommitsCheck?: boolean }) => void;
  setNewCommitsCheck: (projectId: string, prNumber: number, check: NewCommitsCheck) => void;
  /** Update PR status from polling (CI checks, reviews, mergeability) */
  setPRStatus: (projectId: string, prNumber: number, status: {
    checksStatus: ChecksStatus;
    reviewsStatus: ReviewsStatus;
    mergeableState: MergeableState;
    lastPolled: string;
  }) => void;
  /** Clear PR status fields for a specific PR */
  clearPRStatus: (projectId: string, prNumber: number) => void;

  // Notes actions
  /** Set reviewer notes for a PR in the store */
  setNotes: (projectId: string, prNumber: number, notes: string) => void;
  /** Get reviewer notes for a PR from the store */
  getNotes: (projectId: string, prNumber: number) => string;
  /** Load notes from disk via IPC and update store */
  loadNotesFromDisk: (projectId: string, prNumber: number) => Promise<void>;
  /** Save notes to disk via IPC */
  saveNotesToDisk: (projectId: string, prNumber: number, notes: string) => Promise<void>;

  // Manual findings actions
  /**
   * Fetch the persisted manual findings for the given PR via IPC and store the
   * resulting list under `manualFindings[prNumber]`. Silently no-ops on errors —
   * manual findings are non-critical and the UI will simply show AI findings only.
   */
  loadManualFindings: (projectId: string, prNumber: number) => Promise<void>;
  /**
   * Author a new manual finding. The main process generates the canonical id /
   * authoredAt / source fields and emits a `…_CHANGED` event after the write;
   * the listener re-fetches the list, so we don't need to optimistically update
   * the store here. Returns the fully-hydrated finding (or null when the IPC
   * fails / returns null).
   */
  addManualFinding: (projectId: string, prNumber: number, payload: Partial<ManualPRReviewFinding>) => Promise<ManualPRReviewFinding | null>;
  /**
   * Patch mutable fields on an existing manual finding. Immutable audit-trail
   * fields (`id`, `source`, `authoredAt`, `authoredBy`) are silently dropped by
   * the handler. Returns the updated finding or null when no finding matched.
   */
  updateManualFinding: (projectId: string, prNumber: number, id: string, patch: Partial<ManualPRReviewFinding>) => Promise<ManualPRReviewFinding | null>;
  /**
   * Remove a manual finding by id. Returns `true` when a finding was removed.
   */
  deleteManualFinding: (projectId: string, prNumber: number, id: string) => Promise<boolean>;
  /** Read-only selector — returns the current manual findings for a PR (empty array when none). */
  getManualFindings: (prNumber: number) => ManualPRReviewFinding[];

  // Selectors
  getPRReviewState: (projectId: string, prNumber: number) => PRReviewState | null;
  getActivePRReviews: (projectId: string) => PRReviewState[];

  // Refresh callbacks - called when reviews complete
  registerRefreshCallback: (callback: () => void) => void;
  unregisterRefreshCallback: (callback: () => void) => void;
}

// Store for refresh callbacks outside of Zustand state (to avoid re-renders on registration)
const refreshCallbacks = new Set<() => void>();

export const usePRReviewStore = create<PRReviewStoreState>((set, get) => ({
  // Initial state
  prReviews: {},
  manualFindings: {},

  // XState state change handler — maps XState state/context back to PRReviewState shape
  handlePRReviewStateChange: (key: string, payload: PRReviewStatePayload) => {
    const isCompleted = payload.state === 'completed';

    set((state) => {
      const existing = state.prReviews[key];

      const updated: PRReviewState = {
        prNumber: payload.prNumber,
        projectId: payload.projectId,
        isReviewing: payload.state === 'reviewing' || payload.state === 'externalReview',
        startedAt: payload.startedAt,
        progress: payload.progress,
        result: payload.result,
        previousResult: payload.previousResult,
        error: payload.error,
        isExternalReview: payload.isExternalReview,
        // Preserve polling data — not managed by XState
        checksStatus: existing?.checksStatus ?? null,
        reviewsStatus: existing?.reviewsStatus ?? null,
        mergeableState: existing?.mergeableState ?? null,
        lastPolled: existing?.lastPolled ?? null,
        // Preserve newCommitsCheck unless review completed (it was just reviewed)
        newCommitsCheck: isCompleted ? null : (existing?.newCommitsCheck ?? null),
        notes: existing?.notes ?? '',
      };

      return {
        prReviews: {
          ...state.prReviews,
          [key]: updated,
        },
      };
    });

    // Trigger registered refresh callbacks when review completes
    if (isCompleted) {
      refreshCallbacks.forEach(callback => {
        Promise.resolve(callback()).catch(error => {
          console.error('[PRReviewStore] Error in refresh callback:', error);
        });
      });
    }
  },

  setLoadedReviewResult: (projectId: string, result: PRReviewResult, options?: { preserveNewCommitsCheck?: boolean }) => set((state) => {
    const key = `${projectId}:${result.prNumber}`;
    const existing = state.prReviews[key];
    // Don't overwrite active review state from XState
    if (existing?.isReviewing) {
      return state;
    }
    return {
      prReviews: {
        ...state.prReviews,
        [key]: {
          prNumber: result.prNumber,
          projectId,
          isReviewing: false,
          startedAt: null,
          progress: null,
          result,
          previousResult: existing?.previousResult ?? null,
          error: null,
          newCommitsCheck: options?.preserveNewCommitsCheck ? (existing?.newCommitsCheck ?? null) : null,
          checksStatus: existing?.checksStatus ?? null,
          reviewsStatus: existing?.reviewsStatus ?? null,
          mergeableState: existing?.mergeableState ?? null,
          lastPolled: existing?.lastPolled ?? null,
          isExternalReview: false,
          notes: existing?.notes ?? '',
        },
      },
    };
  }),

  setNewCommitsCheck: (projectId: string, prNumber: number, check: NewCommitsCheck) => set((state) => {
    const key = `${projectId}:${prNumber}`;
    const existing = state.prReviews[key];
    if (!existing) {
      // Create a minimal state if none exists
      return {
        prReviews: {
          ...state.prReviews,
          [key]: {
            prNumber,
            projectId,
            isReviewing: false,
            startedAt: null,
            progress: null,
            result: null,
            previousResult: null,
            error: null,
            newCommitsCheck: check,
            checksStatus: null,
            reviewsStatus: null,
            mergeableState: null,
            lastPolled: null,
            isExternalReview: false,
            notes: ''
          }
        }
      };
    }
    return {
      prReviews: {
        ...state.prReviews,
        [key]: {
          ...existing,
          newCommitsCheck: check
        }
      }
    };
  }),


  setPRStatus: (projectId: string, prNumber: number, status: {
    checksStatus: ChecksStatus;
    reviewsStatus: ReviewsStatus;
    mergeableState: MergeableState;
    lastPolled: string;
  }) => set((state) => {
    const key = `${projectId}:${prNumber}`;
    const existing = state.prReviews[key];
    if (!existing) {
      // Create a minimal state if none exists
      return {
        prReviews: {
          ...state.prReviews,
          [key]: {
            prNumber,
            projectId,
            isReviewing: false,
            startedAt: null,
            progress: null,
            result: null,
            previousResult: null,
            error: null,
            newCommitsCheck: null,
            checksStatus: status.checksStatus,
            reviewsStatus: status.reviewsStatus,
            mergeableState: status.mergeableState,
            lastPolled: status.lastPolled,
            isExternalReview: false,
            notes: ''
          }
        }
      };
    }
    return {
      prReviews: {
        ...state.prReviews,
        [key]: {
          ...existing,
          checksStatus: status.checksStatus,
          reviewsStatus: status.reviewsStatus,
          mergeableState: status.mergeableState,
          lastPolled: status.lastPolled
        }
      }
    };
  }),

  clearPRStatus: (projectId: string, prNumber: number) => set((state) => {
    const key = `${projectId}:${prNumber}`;
    const existing = state.prReviews[key];
    if (!existing) {
      return state;
    }
    return {
      prReviews: {
        ...state.prReviews,
        [key]: {
          ...existing,
          checksStatus: null,
          reviewsStatus: null,
          mergeableState: null,
          lastPolled: null
        }
      }
    };
  }),

  // Notes actions
  setNotes: (projectId: string, prNumber: number, notes: string) => set((state) => {
    const key = `${projectId}:${prNumber}`;
    const existing = state.prReviews[key];
    if (!existing) {
      return {
        prReviews: {
          ...state.prReviews,
          [key]: {
            prNumber,
            projectId,
            isReviewing: false,
            startedAt: null,
            progress: null,
            result: null,
            previousResult: null,
            error: null,
            newCommitsCheck: null,
            checksStatus: null,
            reviewsStatus: null,
            mergeableState: null,
            lastPolled: null,
            isExternalReview: false,
            notes
          }
        }
      };
    }
    return {
      prReviews: {
        ...state.prReviews,
        [key]: {
          ...existing,
          notes
        }
      }
    };
  }),

  getNotes: (projectId: string, prNumber: number) => {
    const { prReviews } = get();
    const key = `${projectId}:${prNumber}`;
    return prReviews[key]?.notes ?? '';
  },

  loadNotesFromDisk: async (projectId: string, prNumber: number) => {
    try {
      const notes = await window.electronAPI.github.loadPRNotes(projectId, prNumber);
      if (notes) {
        get().setNotes(projectId, prNumber, notes);
      }
    } catch {
      // Silently fail — notes are non-critical
    }
  },

  saveNotesToDisk: async (projectId: string, prNumber: number, notes: string) => {
    try {
      await window.electronAPI.github.savePRNotes(projectId, prNumber, notes);
    } catch {
      // Silently fail — notes are non-critical
    }
  },

  // Manual findings actions
  loadManualFindings: async (projectId: string, prNumber: number) => {
    try {
      const findings = await window.electronAPI.github.pr.manualFindings.list(projectId, prNumber);
      set((state) => ({
        manualFindings: {
          ...state.manualFindings,
          [prNumber]: findings ?? []
        }
      }));
    } catch (error) {
      // Silently fail — manual findings are non-critical; surface as empty list.
      console.error('[PRReviewStore] Failed to load manual findings:', error);
      set((state) => ({
        manualFindings: {
          ...state.manualFindings,
          [prNumber]: state.manualFindings[prNumber] ?? []
        }
      }));
    }
  },

  addManualFinding: async (projectId: string, prNumber: number, payload: Partial<ManualPRReviewFinding>) => {
    try {
      // The handler emits a CHANGED event after the write — the store will
      // re-fetch via the global listener, so we don't need to mutate state here.
      // Returning the hydrated finding lets the caller use the new id/authoredAt.
      return await window.electronAPI.github.pr.manualFindings.add(projectId, prNumber, payload);
    } catch (error) {
      console.error('[PRReviewStore] Failed to add manual finding:', error);
      return null;
    }
  },

  updateManualFinding: async (projectId: string, prNumber: number, id: string, patch: Partial<ManualPRReviewFinding>) => {
    try {
      return await window.electronAPI.github.pr.manualFindings.update(projectId, prNumber, id, patch);
    } catch (error) {
      console.error('[PRReviewStore] Failed to update manual finding:', error);
      return null;
    }
  },

  deleteManualFinding: async (projectId: string, prNumber: number, id: string) => {
    try {
      return await window.electronAPI.github.pr.manualFindings.delete_(projectId, prNumber, id);
    } catch (error) {
      console.error('[PRReviewStore] Failed to delete manual finding:', error);
      return false;
    }
  },

  getManualFindings: (prNumber: number) => {
    return get().manualFindings[prNumber] ?? [];
  },

  // Selectors
  getPRReviewState: (projectId: string, prNumber: number) => {
    const { prReviews } = get();
    const key = `${projectId}:${prNumber}`;
    return prReviews[key] ?? null;
  },

  getActivePRReviews: (projectId: string) => {
    const { prReviews } = get();
    return Object.values(prReviews).filter(
      review => review.projectId === projectId && review.isReviewing
    );
  },

  // Refresh callbacks - called when reviews complete
  registerRefreshCallback: (callback: () => void) => {
    refreshCallbacks.add(callback);
  },

  unregisterRefreshCallback: (callback: () => void) => {
    refreshCallbacks.delete(callback);
  }
}));

/**
 * Global IPC listener setup for PR reviews.
 * Call this once at app startup to ensure PR review events are captured
 * regardless of which component is mounted.
 */
let prReviewListenersInitialized = false;
let cleanupFunctions: (() => void)[] = [];

export function initializePRReviewListeners(): void {
  if (prReviewListenersInitialized) {
    return;
  }

  const store = usePRReviewStore.getState();

  // Check if GitHub PR Review API is available
  if (!window.electronAPI?.github?.onPRReviewStateChange) {
    console.warn('[GitHub PR Store] GitHub PR Review API not available, skipping listener setup');
    return;
  }

  // Listen for XState state changes — single handler replaces progress/complete/error listeners
  const cleanupStateChange = window.electronAPI.github.onPRReviewStateChange(
    (key: string, payload: PRReviewStatePayload) => {
      store.handlePRReviewStateChange(key, payload);
    }
  );
  cleanupFunctions.push(cleanupStateChange);

  // Listen for GitHub auth changes - clear all PR review state when account changes
  const cleanupAuthChanged = window.electronAPI.github.onGitHubAuthChanged(
    (data: { oldUsername: string | null; newUsername: string }) => {
      console.warn(
        `[PRReviewStore] GitHub auth changed from "${data.oldUsername ?? 'none'}" to "${data.newUsername}". ` +
        `Clearing all PR review state.`
      );
      // Clear all PR review + manual finding state since the token has changed
      usePRReviewStore.setState({ prReviews: {}, manualFindings: {} });
    }
  );
  cleanupFunctions.push(cleanupAuthChanged);

  // Listen for manual-findings change events — emitted by the main process for
  // both in-app mutations (`add`/`update`/`delete`) and chokidar-detected
  // external writes (`external` / `file-deleted`). On `file-deleted` we clear
  // the slice for that PR; on every other reason we re-fetch the canonical list.
  if (window.electronAPI?.github?.pr?.manualFindings?.onChanged) {
    const cleanupManualFindingsChanged = window.electronAPI.github.pr.manualFindings.onChanged(
      (projectId: string, prNumber: number, reason: ManualFindingsChangeReason) => {
        if (reason === 'file-deleted') {
          usePRReviewStore.setState((state) => ({
            manualFindings: {
              ...state.manualFindings,
              [prNumber]: []
            }
          }));
          return;
        }
        // 'add' | 'update' | 'delete' | 'external' — re-fetch the canonical list
        void usePRReviewStore.getState().loadManualFindings(projectId, prNumber);
      }
    );
    cleanupFunctions.push(cleanupManualFindingsChanged);
  }

  // Listen for PR status polling updates (CI checks, reviews, mergeability)
  const cleanupStatusUpdate = window.electronAPI.github.onPRStatusUpdate(
    (update: PRStatusUpdate) => {
      const { projectId, statuses } = update;
      for (const status of statuses) {
        store.setPRStatus(projectId, status.prNumber, {
          checksStatus: status.checksStatus,
          reviewsStatus: status.reviewsStatus,
          mergeableState: status.mergeableState,
          lastPolled: status.lastPolled ?? new Date().toISOString()
        });
      }
    }
  );
  cleanupFunctions.push(cleanupStatusUpdate);

  prReviewListenersInitialized = true;
}

/**
 * Cleanup PR review listeners.
 * Call this when the app is being unmounted or during hot-reload.
 */
export function cleanupPRReviewListeners(): void {
  for (const cleanup of cleanupFunctions) {
    try {
      cleanup();
    } catch {
      // Ignore cleanup errors
    }
  }
  cleanupFunctions = [];
  refreshCallbacks.clear();
  prReviewListenersInitialized = false;
}

/**
 * Start a PR review and track it in the store.
 * Optionally accepts reviewer notes to include in the review.
 */
export function startPRReview(projectId: string, prNumber: number, notes?: string): void {
  window.electronAPI.github.runPRReview(projectId, prNumber, notes);
}
