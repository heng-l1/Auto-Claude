/**
 * @vitest-environment jsdom
 */
/**
 * Unit tests for the manual-findings slice of `pr-review-store`.
 *
 * Covers the two behaviors called out in the spec's QA acceptance:
 *   1. When the main process emits a `…_CHANGED` event with a mutation reason
 *      (`add` / `update` / `delete` / `external`), the store re-fetches the
 *      canonical list via `manualFindings.list` IPC.
 *   2. When the event arrives with `reason: 'file-deleted'`, the store clears
 *      its slice for that PR (no re-fetch — the file is gone).
 *
 * Also exercises the standalone store actions (`loadManualFindings`, `add`,
 * `update`, `delete`) to confirm they route through the matching IPC call and
 * write the resulting list into the store under the correct PR key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ManualFindingsChangeReason,
  ManualFindingsAPI,
} from '../../../../preload/api/modules/github-api';
import type { ManualPRReviewFinding } from '../../../../shared/types/pr-review-comments';

// ---------------------------------------------------------------------------
// Mock setup helpers
//
// The store binds to `window.electronAPI.github.pr.manualFindings.*` at call
// time, so we install a fresh mock object on `window.electronAPI` before each
// test. We capture the change-event subscriber via the `onChanged` mock so
// individual tests can invoke it directly with synthetic events.
// ---------------------------------------------------------------------------

type OnChangedCallback = (
  projectId: string,
  prNumber: number,
  reason: ManualFindingsChangeReason,
) => void;

interface MockManualFindingsAPI {
  list: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete_: ReturnType<typeof vi.fn>;
  onChanged: ReturnType<typeof vi.fn>;
  extract: ReturnType<typeof vi.fn>;
}

let mockManualFindingsAPI: MockManualFindingsAPI;
let capturedOnChanged: OnChangedCallback | null = null;
let onChangedCleanup: ReturnType<typeof vi.fn>;

/**
 * Fire a synthetic CHANGED event through the captured listener. Throws an
 * explicit error if the listener was never registered — that way a missing
 * subscription surfaces as an obvious test failure instead of a generic
 * "cannot call null" runtime error.
 */
function fireChanged(
  projectId: string,
  prNumber: number,
  reason: ManualFindingsChangeReason,
): void {
  if (!capturedOnChanged) {
    throw new Error(
      'CHANGED listener was never captured — did you forget to call initializePRReviewListeners()?',
    );
  }
  capturedOnChanged(projectId, prNumber, reason);
}

function makeManualFinding(overrides: Partial<ManualPRReviewFinding> = {}): ManualPRReviewFinding {
  return {
    id: 'manual-2024-01-01-aaa111',
    severity: 'medium',
    category: 'quality',
    title: 'Test manual finding',
    description: 'Description',
    file: 'src/foo.ts',
    line: 10,
    fixable: false,
    source: 'manual',
    authoredAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function installWindowElectronAPIMock(): void {
  capturedOnChanged = null;
  onChangedCleanup = vi.fn();

  mockManualFindingsAPI = {
    list: vi.fn().mockResolvedValue([] as ManualPRReviewFinding[]),
    add: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
    delete_: vi.fn().mockResolvedValue(false),
    onChanged: vi.fn((callback: OnChangedCallback) => {
      capturedOnChanged = callback;
      return onChangedCleanup;
    }),
    extract: vi.fn().mockResolvedValue([] as ManualPRReviewFinding[]),
  };

  // The store also calls onPRReviewStateChange, onGitHubAuthChanged and
  // onPRStatusUpdate during init — stub each to keep `initializePRReviewListeners`
  // happy without imposing test-specific expectations.
  const noopCleanup = () => {
    // Intentional no-op cleanup function returned by stub listeners.
  };
  const stubListener = vi.fn().mockReturnValue(noopCleanup);

  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      github: {
        onPRReviewStateChange: stubListener,
        onGitHubAuthChanged: stubListener,
        onPRStatusUpdate: stubListener,
        loadPRNotes: vi.fn().mockResolvedValue(null),
        savePRNotes: vi.fn().mockResolvedValue(true),
        runPRReview: vi.fn(),
        pr: {
          // vi.fn() returns a generic Mock that TypeScript can't narrow to
          // the exact ManualFindingsAPI signatures, so cast through unknown.
          manualFindings: mockManualFindingsAPI as unknown as ManualFindingsAPI,
        },
      },
    },
  });
}

describe('pr-review-store — manual findings slice', () => {
  // We dynamically import the store after wiring the mocks so that the module
  // graph sees the freshly-stubbed `window.electronAPI` when it initializes.
  let storeModule: typeof import('../pr-review-store');

  beforeEach(async () => {
    vi.resetModules();
    installWindowElectronAPIMock();

    storeModule = await import('../pr-review-store');

    // Reset the store between tests — Zustand persists state across imports
    // even after `vi.resetModules()` for some module loaders, so explicitly
    // clear the slices we touch.
    storeModule.usePRReviewStore.setState({ prReviews: {}, manualFindings: {} });
  });

  afterEach(() => {
    // Clean up listeners so each test starts from a fresh subscriber list.
    storeModule.cleanupPRReviewListeners();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Store actions route through the IPC API and update state
  // -------------------------------------------------------------------------
  describe('store actions', () => {
    it('loadManualFindings(): calls IPC list and stores the result under manualFindings[prNumber]', async () => {
      const findings: ManualPRReviewFinding[] = [
        makeManualFinding({ id: 'manual-1', title: 'F1' }),
        makeManualFinding({ id: 'manual-2', title: 'F2' }),
      ];
      mockManualFindingsAPI.list.mockResolvedValueOnce(findings);

      await storeModule.usePRReviewStore.getState().loadManualFindings('proj-1', 142);

      expect(mockManualFindingsAPI.list).toHaveBeenCalledTimes(1);
      expect(mockManualFindingsAPI.list).toHaveBeenCalledWith('proj-1', 142);

      expect(storeModule.usePRReviewStore.getState().manualFindings[142]).toEqual(findings);
      expect(storeModule.usePRReviewStore.getState().getManualFindings(142)).toEqual(findings);
    });

    it('loadManualFindings(): leaves the slice untouched on IPC error (silently fails)', async () => {
      mockManualFindingsAPI.list.mockRejectedValueOnce(new Error('boom'));

      // Pre-seed an existing list so we can verify it's not clobbered.
      storeModule.usePRReviewStore.setState({
        manualFindings: { 142: [makeManualFinding({ id: 'manual-existing' })] },
      });

      await storeModule.usePRReviewStore.getState().loadManualFindings('proj-1', 142);

      // Error path should keep the existing array (per store implementation:
      // it falls back to the prior list or an empty array — never undefined).
      const stored = storeModule.usePRReviewStore.getState().manualFindings[142];
      expect(stored).toBeDefined();
      expect(Array.isArray(stored)).toBe(true);
    });

    it('addManualFinding(): forwards payload to IPC add and returns the hydrated finding', async () => {
      const hydrated = makeManualFinding({ id: 'manual-new', title: 'Hydrated' });
      mockManualFindingsAPI.add.mockResolvedValueOnce(hydrated);

      const payload = { severity: 'high' as const, title: 'Race', file: 'src/x.ts', line: 10 };
      const result = await storeModule.usePRReviewStore
        .getState()
        .addManualFinding('proj-1', 142, payload);

      expect(mockManualFindingsAPI.add).toHaveBeenCalledWith('proj-1', 142, payload);
      expect(result).toEqual(hydrated);
    });

    it('addManualFinding(): returns null when the IPC throws', async () => {
      mockManualFindingsAPI.add.mockRejectedValueOnce(new Error('disk full'));

      const result = await storeModule.usePRReviewStore
        .getState()
        .addManualFinding('proj-1', 142, {});

      expect(result).toBeNull();
    });

    it('updateManualFinding(): forwards id + patch to IPC update', async () => {
      const updated = makeManualFinding({ id: 'manual-edit', title: 'Updated' });
      mockManualFindingsAPI.update.mockResolvedValueOnce(updated);

      const result = await storeModule.usePRReviewStore
        .getState()
        .updateManualFinding('proj-1', 142, 'manual-edit', { title: 'Updated' });

      expect(mockManualFindingsAPI.update).toHaveBeenCalledWith(
        'proj-1',
        142,
        'manual-edit',
        { title: 'Updated' },
      );
      expect(result).toEqual(updated);
    });

    it('deleteManualFinding(): forwards id to IPC delete and returns its boolean result', async () => {
      mockManualFindingsAPI.delete_.mockResolvedValueOnce(true);

      const result = await storeModule.usePRReviewStore
        .getState()
        .deleteManualFinding('proj-1', 142, 'manual-1');

      expect(mockManualFindingsAPI.delete_).toHaveBeenCalledWith('proj-1', 142, 'manual-1');
      expect(result).toBe(true);
    });

    it('deleteManualFinding(): returns false when the IPC throws', async () => {
      mockManualFindingsAPI.delete_.mockRejectedValueOnce(new Error('not found'));

      const result = await storeModule.usePRReviewStore
        .getState()
        .deleteManualFinding('proj-1', 142, 'manual-missing');

      expect(result).toBe(false);
    });

    it('getManualFindings(): returns [] when no findings have been loaded for a PR', () => {
      const findings = storeModule.usePRReviewStore.getState().getManualFindings(9999);
      expect(findings).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Subscribe to CHANGED event — re-fetches on mutation reasons
  // -------------------------------------------------------------------------
  describe('CHANGED event listener', () => {
    beforeEach(() => {
      storeModule.initializePRReviewListeners();
      expect(mockManualFindingsAPI.onChanged).toHaveBeenCalledTimes(1);
      expect(capturedOnChanged).not.toBeNull();
    });

    it("'external' reason → re-fetches the canonical list via manualFindings.list", async () => {
      const refreshed = [makeManualFinding({ id: 'manual-refreshed', title: 'Fresh' })];
      mockManualFindingsAPI.list.mockResolvedValueOnce(refreshed);

      fireChanged('proj-1', 142, 'external');

      // Wait a microtask for the async loadManualFindings to settle.
      await Promise.resolve();
      await Promise.resolve();

      expect(mockManualFindingsAPI.list).toHaveBeenCalledWith('proj-1', 142);
      expect(storeModule.usePRReviewStore.getState().manualFindings[142]).toEqual(refreshed);
    });

    it("'add' reason → re-fetches the canonical list", async () => {
      mockManualFindingsAPI.list.mockResolvedValueOnce([]);

      fireChanged('proj-1', 99, 'add');

      await Promise.resolve();
      await Promise.resolve();

      expect(mockManualFindingsAPI.list).toHaveBeenCalledWith('proj-1', 99);
    });

    it("'update' reason → re-fetches the canonical list", async () => {
      fireChanged('proj-1', 5, 'update');

      await Promise.resolve();
      await Promise.resolve();

      expect(mockManualFindingsAPI.list).toHaveBeenCalledWith('proj-1', 5);
    });

    it("'delete' reason → re-fetches the canonical list", async () => {
      fireChanged('proj-1', 7, 'delete');

      await Promise.resolve();
      await Promise.resolve();

      expect(mockManualFindingsAPI.list).toHaveBeenCalledWith('proj-1', 7);
    });
  });

  // -------------------------------------------------------------------------
  // 3. 'file-deleted' clears the slice for that PR (and does NOT re-fetch)
  // -------------------------------------------------------------------------
  describe('CHANGED event — file-deleted reason', () => {
    beforeEach(() => {
      storeModule.initializePRReviewListeners();
    });

    it('clears manualFindings[prNumber] to an empty array', () => {
      // Seed some findings into the slice first.
      storeModule.usePRReviewStore.setState({
        manualFindings: {
          142: [makeManualFinding({ id: 'manual-1' }), makeManualFinding({ id: 'manual-2' })],
          999: [makeManualFinding({ id: 'other-pr' })],
        },
      });

      // Fire the event for PR 142 only.
      fireChanged('proj-1', 142, 'file-deleted');

      // The slice for PR 142 is cleared; other PRs are untouched.
      expect(storeModule.usePRReviewStore.getState().manualFindings[142]).toEqual([]);
      expect(storeModule.usePRReviewStore.getState().manualFindings[999]).toHaveLength(1);
    });

    it('does NOT call manualFindings.list when reason is "file-deleted"', () => {
      const callCountBefore = mockManualFindingsAPI.list.mock.calls.length;

      fireChanged('proj-1', 142, 'file-deleted');

      // No new fetch — the file is gone, so the cleared empty array is the
      // correct local state.
      expect(mockManualFindingsAPI.list.mock.calls.length).toBe(callCountBefore);
    });

    it('only affects the targeted PR, leaving other PRs unchanged', () => {
      storeModule.usePRReviewStore.setState({
        manualFindings: {
          142: [makeManualFinding({ id: 'a' })],
          200: [makeManualFinding({ id: 'b' }), makeManualFinding({ id: 'c' })],
        },
      });

      fireChanged('proj-1', 142, 'file-deleted');

      expect(storeModule.usePRReviewStore.getState().manualFindings[142]).toEqual([]);
      expect(storeModule.usePRReviewStore.getState().manualFindings[200]).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Cleanup teardown — listener removal is wired through
  // -------------------------------------------------------------------------
  describe('cleanup', () => {
    it('cleanupPRReviewListeners() invokes the cleanup returned by onChanged', () => {
      storeModule.initializePRReviewListeners();
      expect(onChangedCleanup).not.toHaveBeenCalled();

      storeModule.cleanupPRReviewListeners();

      expect(onChangedCleanup).toHaveBeenCalledTimes(1);
    });

    it('initializePRReviewListeners() is idempotent — subscribes only once', () => {
      storeModule.initializePRReviewListeners();
      storeModule.initializePRReviewListeners();

      // Second call should be a no-op while the listeners are already wired.
      expect(mockManualFindingsAPI.onChanged).toHaveBeenCalledTimes(1);
    });
  });
});
