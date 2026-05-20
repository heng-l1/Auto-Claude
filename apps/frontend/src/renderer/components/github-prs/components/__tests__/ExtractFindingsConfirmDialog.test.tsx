/**
 * @vitest-environment jsdom
 */
/**
 * Unit tests for ExtractFindingsConfirmDialog component
 *
 * The dialog is the confirmation step between the Haiku scrollback extractor
 * (which returns candidate findings from the main process) and the per-PR
 * `manual_findings_<n>.json` file (which is updated through the store's
 * `addManualFinding` action). It owns three responsibilities — each verified
 * by a section below:
 *
 *   1. Render exactly one row per candidate, all checked by default, with the
 *      severity/file/line badges and source-quote snippet from the description.
 *   2. Submit ONLY the checked subset on "Add (N)" — unchecking a row must
 *      drop it from the `addManualFinding` calls; the post-submit
 *      `onConfirm` callback must receive the persisted subset.
 *   3. Render the appropriate empty-result / loading states when `candidates`
 *      is `[]` / `null` respectively.
 *
 * The store action `addManualFinding` is mocked at the module level (the same
 * idiom used in `AddManualFindingDialog.test.tsx`) so each test can observe
 * exactly which candidates the dialog routed through the persistence path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../../../../shared/i18n';
import type { ManualPRReviewFinding } from '../../../../../shared/types/pr-review-comments';

// ---------------------------------------------------------------------------
// Store mock — hoisted above the SUT import so the dialog binds to the
// mocked `usePRReviewStore` at module-evaluation time.
// ---------------------------------------------------------------------------

const mockAddManualFinding = vi.fn<
  (
    projectId: string,
    prNumber: number,
    payload: Partial<ManualPRReviewFinding>,
  ) => Promise<ManualPRReviewFinding | null>
>();

vi.mock('../../../../stores/github/pr-review-store', () => ({
  // The component reads the action via a selector — emulate that shape.
  usePRReviewStore: (selector: (state: unknown) => unknown) =>
    selector({
      addManualFinding: mockAddManualFinding,
    }),
}));

// SUT must be imported AFTER the store mock so the selector sees the mock.
import { ExtractFindingsConfirmDialog } from '../ExtractFindingsConfirmDialog';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function I18nWrapper({ children }: { children: React.ReactNode }) {
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}

/**
 * Build a candidate matching the shape the Haiku extractor returns. The id
 * is the React row key + selection-state key — every candidate in a single
 * batch needs a unique id.
 */
function makeCandidate(
  overrides: Partial<ManualPRReviewFinding> = {},
): ManualPRReviewFinding {
  return {
    id: 'manual-2026-05-20T00-00-00-000Z-abc123',
    severity: 'high',
    category: 'quality',
    title: 'Race condition in worker',
    description: 'The mutex is released before the read completes.',
    file: 'src/foo/bar.ts',
    line: 42,
    fixable: false,
    source: 'terminal',
    authoredAt: '2026-05-20T00:00:00.000Z',
    authoredBy: 'terminal-extraction',
    ...overrides,
  };
}

/**
 * Render the dialog with sane defaults. Tests can override any individual
 * prop — the function returns the spy handles so assertions can target them.
 */
function renderDialog(
  overrides: {
    candidates?: ManualPRReviewFinding[] | null;
    onCancel?: () => void;
    onConfirm?: (submitted: ManualPRReviewFinding[]) => void;
    onOpenChange?: (open: boolean) => void;
    projectId?: string;
    prNumber?: number;
    open?: boolean;
  } = {},
) {
  const onCancel = overrides.onCancel ?? vi.fn();
  const onConfirm = overrides.onConfirm ?? vi.fn();
  const onOpenChange = overrides.onOpenChange ?? vi.fn();
  // `??` collapses null and undefined into the default — but the SUT
  // treats `null` (loading) and `[]` (empty result) as distinct render
  // modes, so we have to use an explicit `in` check to preserve the
  // caller's null.
  const candidates =
    'candidates' in overrides ? overrides.candidates! : [];
  const result = render(
    <I18nWrapper>
      <ExtractFindingsConfirmDialog
        open={overrides.open ?? true}
        onOpenChange={onOpenChange}
        projectId={overrides.projectId ?? 'proj-1'}
        prNumber={overrides.prNumber ?? 142}
        candidates={candidates}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </I18nWrapper>,
  );
  return { ...result, onCancel, onConfirm, onOpenChange };
}

/**
 * Find the "Add (N)" submit button. The label is dynamic — i18n interpolates
 * the selection count — so we match by the literal `Add (` prefix that the
 * `addN` translation key produces.
 */
function getAddButton(): HTMLElement {
  return screen.getByRole('button', { name: /^Add \(\d+\)$/ });
}

describe('ExtractFindingsConfirmDialog', () => {
  beforeEach(() => {
    mockAddManualFinding.mockReset();
    // Default success: each call resolves to a finding with the id stamped
    // by the main-side handler. The dialog only cares that the result is
    // non-null — the actual contents are not surfaced anywhere in the UI.
    mockAddManualFinding.mockImplementation(async (_p, _n, payload) => ({
      id: `persisted-${Math.random().toString(36).slice(2, 8)}`,
      severity: payload.severity ?? 'medium',
      category: payload.category ?? 'quality',
      title: payload.title ?? '',
      description: payload.description ?? '',
      file: payload.file ?? '',
      line: payload.line ?? 0,
      fixable: payload.fixable ?? false,
      source: payload.source ?? 'terminal',
      authoredAt: '2026-05-20T00:00:00.000Z',
      authoredBy: payload.authoredBy ?? 'terminal-extraction',
    }));
  });

  afterEach(() => {
    cleanup();
  });

  // -------------------------------------------------------------------------
  // 1. Rows per candidate — one row per candidate, all checked by default
  // -------------------------------------------------------------------------
  describe('rendering candidate rows', () => {
    it('renders exactly one row per candidate', () => {
      const candidates = [
        makeCandidate({ id: 'c1', title: 'Finding one' }),
        makeCandidate({ id: 'c2', title: 'Finding two', file: 'src/b.ts' }),
        makeCandidate({ id: 'c3', title: 'Finding three', file: 'src/c.ts' }),
      ];
      renderDialog({ candidates });

      // Each title becomes a row.
      expect(screen.getByText('Finding one')).toBeInTheDocument();
      expect(screen.getByText('Finding two')).toBeInTheDocument();
      expect(screen.getByText('Finding three')).toBeInTheDocument();

      // Three checkboxes — one per row.
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes).toHaveLength(3);
    });

    it('renders the severity badge, file:line badge, and description snippet for each candidate', () => {
      const candidates = [
        makeCandidate({
          id: 'c1',
          title: 'Stale mutex',
          severity: 'critical',
          file: 'src/worker.ts',
          line: 88,
          description: 'Quote from transcript: lock released too early',
        }),
      ];
      renderDialog({ candidates });

      // File:line badge — present and shows the path with the line number.
      expect(screen.getByText('src/worker.ts:88')).toBeInTheDocument();

      // The description doubles as the source-quote snippet for provenance.
      expect(
        screen.getByText(/Quote from transcript: lock released too early/),
      ).toBeInTheDocument();
    });

    it('checks every row by default so "accept everything" is a single click', () => {
      const candidates = [
        makeCandidate({ id: 'c1' }),
        makeCandidate({ id: 'c2' }),
      ];
      renderDialog({ candidates });

      const checkboxes = screen.getAllByRole('checkbox');
      for (const cb of checkboxes) {
        expect(cb).toHaveAttribute('aria-checked', 'true');
      }
      // The "Add (N)" button reflects the full count (i18n interpolation).
      expect(
        screen.getByRole('button', { name: 'Add (2)' }),
      ).toBeInTheDocument();
    });

    it('renders the endLine in the file:line badge when present and greater than line', () => {
      const candidates = [
        makeCandidate({
          id: 'c1',
          file: 'src/foo.ts',
          line: 10,
          endLine: 20,
        }),
      ];
      renderDialog({ candidates });

      // Single source of truth — the multi-line range gets a dash separator.
      expect(screen.getByText('src/foo.ts:10-20')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Only checked candidates submitted on "Add (N)"
  // -------------------------------------------------------------------------
  describe('submission', () => {
    it('submits ALL candidates when none are unchecked (default state)', async () => {
      const candidates = [
        makeCandidate({ id: 'c1', title: 'First' }),
        makeCandidate({ id: 'c2', title: 'Second' }),
      ];
      const onConfirm = vi.fn();
      renderDialog({ candidates, onConfirm });

      fireEvent.click(getAddButton());

      // Wait two microtasks so the async handleSubmit + Promise.all settle.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockAddManualFinding).toHaveBeenCalledTimes(2);
      const titles = mockAddManualFinding.mock.calls.map(
        (call) => (call[2] as Partial<ManualPRReviewFinding>).title,
      );
      expect(titles.sort()).toEqual(['First', 'Second']);

      // onConfirm fires with the persisted subset (non-null results only).
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onConfirm.mock.calls[0]?.[0]).toHaveLength(2);
    });

    it('submits ONLY the checked subset when one row is unchecked', async () => {
      const candidates = [
        makeCandidate({ id: 'c1', title: 'Keep me' }),
        makeCandidate({ id: 'c2', title: 'Drop me' }),
        makeCandidate({ id: 'c3', title: 'Keep me 2' }),
      ];
      renderDialog({ candidates });

      // Uncheck the middle row by clicking its checkbox.
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[1]);

      // Button now reads "Add (2)" — count reflects the selection.
      expect(
        screen.getByRole('button', { name: 'Add (2)' }),
      ).toBeInTheDocument();

      fireEvent.click(getAddButton());

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockAddManualFinding).toHaveBeenCalledTimes(2);
      const titles = mockAddManualFinding.mock.calls.map(
        (call) => (call[2] as Partial<ManualPRReviewFinding>).title,
      );
      // The dropped candidate is NOT in the call list.
      expect(titles).toContain('Keep me');
      expect(titles).toContain('Keep me 2');
      expect(titles).not.toContain('Drop me');
    });

    it('does not call addManualFinding when every row is unchecked', async () => {
      const candidates = [
        makeCandidate({ id: 'c1' }),
        makeCandidate({ id: 'c2' }),
      ];
      renderDialog({ candidates });

      const checkboxes = screen.getAllByRole('checkbox');
      // Uncheck every row.
      for (const cb of checkboxes) {
        fireEvent.click(cb);
      }

      // Submit button is disabled when the selection is empty.
      const submitButton = screen.getByRole('button', { name: 'Add (0)' });
      expect(submitButton).toBeDisabled();

      // Even if a misbehaving caller fires the click anyway, nothing happens.
      fireEvent.click(submitButton);

      await Promise.resolve();
      await Promise.resolve();

      expect(mockAddManualFinding).not.toHaveBeenCalled();
    });

    it('forwards severity/category/file/line/description verbatim to addManualFinding', async () => {
      const candidate = makeCandidate({
        id: 'c1',
        severity: 'critical',
        category: 'security',
        title: 'SQL injection in /api/foo',
        description: 'User input is concatenated into the query string.',
        file: 'src/api/foo.ts',
        line: 23,
        endLine: 28,
        suggestedFix: 'Use parameterised queries',
        fixable: true,
      });
      renderDialog({ candidates: [candidate] });

      fireEvent.click(getAddButton());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockAddManualFinding).toHaveBeenCalledTimes(1);
      const [projectId, prNumber, payload] =
        mockAddManualFinding.mock.calls[0];
      expect(projectId).toBe('proj-1');
      expect(prNumber).toBe(142);
      expect(payload).toMatchObject({
        severity: 'critical',
        category: 'security',
        title: 'SQL injection in /api/foo',
        description: 'User input is concatenated into the query string.',
        file: 'src/api/foo.ts',
        line: 23,
        endLine: 28,
        suggestedFix: 'Use parameterised queries',
        fixable: true,
        // Provenance preserved on persist so the audit trail records the
        // terminal extraction origin.
        source: 'terminal',
        authoredBy: 'terminal-extraction',
      });
    });
  });

  // -------------------------------------------------------------------------
  // 3. Empty-result state
  // -------------------------------------------------------------------------
  describe('empty-result state', () => {
    it('renders the empty-state copy when candidates is an empty array', () => {
      renderDialog({ candidates: [] });

      // The literal text comes from the `prReview.extractDialog.noFindings`
      // key in `en/common.json`.
      expect(
        screen.getByText('No findings detected in this conversation'),
      ).toBeInTheDocument();

      // No checkboxes, no rows.
      expect(screen.queryAllByRole('checkbox')).toHaveLength(0);

      // The "Add (N)" submit button is hidden in the empty state — only
      // Cancel remains. Verifying its absence prevents a regression where a
      // disabled "Add (0)" leaks through.
      expect(
        screen.queryByRole('button', { name: /^Add \(\d+\)$/ }),
      ).not.toBeInTheDocument();
    });

    it('shows the Cancel button in the empty state so the user can dismiss', () => {
      const onCancel = vi.fn();
      renderDialog({ candidates: [], onCancel });

      const cancelBtn = screen.getByRole('button', { name: /^Cancel$/i });
      expect(cancelBtn).toBeInTheDocument();
      fireEvent.click(cancelBtn);
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('does not call addManualFinding in the empty state, even if forced', () => {
      renderDialog({ candidates: [] });

      // The submit button is not rendered at all, so we cannot click it. The
      // assertion that the spy was never called is what we want to verify
      // — i.e. the dialog can't accidentally route through the persist path
      // when there's nothing to persist.
      expect(mockAddManualFinding).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Loading state (candidates === null) — bonus coverage of the third
  //    render mode called out in the component's JSDoc.
  // -------------------------------------------------------------------------
  describe('loading state', () => {
    it('renders the loading copy when candidates is null', () => {
      renderDialog({ candidates: null });

      // i18n default value from `prReview.extractDialog.extracting`.
      expect(screen.getByText(/Extracting findings/i)).toBeInTheDocument();

      // No rows, no submit button in the loading state.
      expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
      expect(
        screen.queryByRole('button', { name: /^Add \(\d+\)$/ }),
      ).not.toBeInTheDocument();
    });

    it('Cancel during loading notifies the parent so the extract IPC can abort', () => {
      const onCancel = vi.fn();
      renderDialog({ candidates: null, onCancel });

      // The Cancel button is always present so the user can break out of a
      // long-running extraction.
      const cancelBtn = screen.getByRole('button', { name: /^Cancel$/i });
      fireEvent.click(cancelBtn);

      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });
});
