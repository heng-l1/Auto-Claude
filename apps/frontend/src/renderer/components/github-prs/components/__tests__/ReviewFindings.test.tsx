/**
 * @vitest-environment jsdom
 */
/**
 * Unit tests for the ReviewFindings component — extending the suite to cover
 * the manual-findings overlay (per spec QA acceptance):
 *
 *   1. Source badges render on the correct rows ("Manual" on manual findings,
 *      "From terminal" on terminal-authored findings, none on AI findings).
 *   2. The pencil + trash inline actions appear on manual rows only — AI rows
 *      stay immutable.
 *   3. "Select all" includes BOTH the AI findings and the manual findings — the
 *      merged list flows through the existing `useFindingSelection` hook.
 *
 * These tests render the component through the real i18n provider so the
 * displayed labels resolve to the production English copy (matches the
 * pattern used by PRDetail.integration.test.tsx).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../../../../shared/i18n';
import { ReviewFindings } from '../ReviewFindings';
import { FindingItem } from '../FindingItem';
import type { PRReviewFinding } from '../../../../../shared/types/pr-review-comments';
import type { PRData } from '../../../../../preload/api/modules/github-api';

// The FindingItem (rendered as a child of ReviewFindings) reaches into the
// pr-review-store for the deleteManualFinding action. We don't exercise that
// branch in this suite, but we still need to mock the module so render doesn't
// blow up trying to talk to IPC.
vi.mock('../../../../stores/github/pr-review-store', () => ({
  usePRReviewStore: (selector: (state: unknown) => unknown) =>
    selector({
      addManualFinding: vi.fn(),
      updateManualFinding: vi.fn(),
      deleteManualFinding: vi.fn(),
    }),
}));

function I18nWrapper({ children }: { children: React.ReactNode }) {
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}

function makeFinding(overrides: Partial<PRReviewFinding> = {}): PRReviewFinding {
  return {
    id: 'finding-x',
    severity: 'high',
    category: 'quality',
    title: 'Some issue',
    description: 'A description',
    file: 'src/foo/bar.ts',
    line: 10,
    fixable: false,
    ...overrides,
  };
}

function makePR(overrides: Partial<PRData> = {}): PRData {
  return {
    number: 142,
    title: '',
    body: '',
    state: 'open',
    author: { login: 'u' },
    headRefName: 'h',
    baseRefName: 'b',
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

describe('ReviewFindings — manual findings overlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // -------------------------------------------------------------------------
  // 1. Source badges
  // -------------------------------------------------------------------------
  describe('source badges', () => {
    it('renders a "Manual" badge on manual findings and "From terminal" on terminal findings', () => {
      const aiFinding = makeFinding({
        id: 'ai-1',
        title: 'AI-detected issue',
        // source is undefined → treated as AI
      });
      const manualFinding = makeFinding({
        id: 'manual-1',
        title: 'Human-authored issue',
        source: 'manual',
        authoredAt: '2024-01-02T00:00:00Z',
      });
      const terminalFinding = makeFinding({
        id: 'manual-2',
        title: 'Captured from terminal',
        source: 'terminal',
        authoredAt: '2024-01-03T00:00:00Z',
      });

      render(
        <I18nWrapper>
          <ReviewFindings
            findings={[aiFinding]}
            manualFindings={[manualFinding, terminalFinding]}
            selectedIds={new Set()}
            onSelectionChange={vi.fn()}
          />
        </I18nWrapper>,
      );

      // The badge text comes from the prReview.findings.source.* keys.
      expect(screen.getByText('Manual')).toBeInTheDocument();
      expect(screen.getByText('Terminal')).toBeInTheDocument();
    });

    it('does NOT render a source badge for AI findings (source missing or "ai")', () => {
      const aiNoSource = makeFinding({
        id: 'ai-1',
        title: 'AI finding without source',
        source: undefined,
      });
      const aiExplicit = makeFinding({
        id: 'ai-2',
        title: 'AI finding with explicit source',
        source: 'ai',
      });

      render(
        <I18nWrapper>
          <ReviewFindings
            findings={[aiNoSource, aiExplicit]}
            manualFindings={[]}
            selectedIds={new Set()}
            onSelectionChange={vi.fn()}
          />
        </I18nWrapper>,
      );

      // Neither AI row should carry the manual/terminal badges. The category
      // badge ("Quality") is still rendered, which is the expected behaviour.
      expect(screen.queryByText('Manual')).not.toBeInTheDocument();
      expect(screen.queryByText('Terminal')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Pencil + trash icons appear on manual rows only
  //
  // The inline action affordances live on `FindingItem` (the row primitive
  // rendered inside ReviewFindings). FindingItem gates the buttons on
  // `canEditOrDelete = isManual && projectId != null && pr != null`. We test
  // the row directly here because that's the unit under test — exercising it
  // through ReviewFindings would only test the same FindingItem twice.
  // -------------------------------------------------------------------------
  describe('inline edit/delete affordances (FindingItem rendered as the row primitive)', () => {
    it('renders pencil + trash buttons on a manual finding row when projectId + pr are provided', () => {
      const manualFinding = makeFinding({
        id: 'manual-1',
        title: 'Manual finding — editable',
        source: 'manual',
        authoredAt: '2024-01-02T00:00:00Z',
      });

      render(
        <I18nWrapper>
          <FindingItem
            finding={manualFinding}
            selected={false}
            onToggle={vi.fn()}
            projectId="proj-1"
            pr={makePR()}
          />
        </I18nWrapper>,
      );

      // Both inline actions render — the hover state only toggles opacity, so
      // the buttons exist in the DOM at all times.
      expect(screen.getByRole('button', { name: /^edit finding$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^delete finding$/i })).toBeInTheDocument();
    });

    it('does NOT render pencil + trash buttons on AI rows even with projectId + pr', () => {
      const aiFinding = makeFinding({
        id: 'ai-1',
        title: 'AI finding — immutable',
        source: 'ai',
      });

      render(
        <I18nWrapper>
          <FindingItem
            finding={aiFinding}
            selected={false}
            onToggle={vi.fn()}
            projectId="proj-1"
            pr={makePR()}
          />
        </I18nWrapper>,
      );

      // AI rows stay read-only — no inline actions anywhere on the row.
      expect(screen.queryByRole('button', { name: /^edit finding$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^delete finding$/i })).not.toBeInTheDocument();
    });

    it('does NOT render pencil + trash buttons on findings with no source (legacy AI)', () => {
      const legacyFinding = makeFinding({
        id: 'legacy-1',
        title: 'Legacy AI finding with no source field',
        // source intentionally omitted
      });

      render(
        <I18nWrapper>
          <FindingItem
            finding={legacyFinding}
            selected={false}
            onToggle={vi.fn()}
            projectId="proj-1"
            pr={makePR()}
          />
        </I18nWrapper>,
      );

      // Legacy records (no `source`) are treated as AI for back-compat.
      expect(screen.queryByRole('button', { name: /^edit finding$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^delete finding$/i })).not.toBeInTheDocument();
    });

    it('renders pencil + trash buttons on terminal-authored findings too', () => {
      const terminalFinding = makeFinding({
        id: 'manual-2',
        title: 'Terminal-authored finding',
        source: 'terminal',
        authoredAt: '2024-01-03T00:00:00Z',
      });

      render(
        <I18nWrapper>
          <FindingItem
            finding={terminalFinding}
            selected={false}
            onToggle={vi.fn()}
            projectId="proj-1"
            pr={makePR()}
          />
        </I18nWrapper>,
      );

      // Both manual and terminal sources count as "user-authored" — both editable.
      expect(screen.getByRole('button', { name: /^edit finding$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^delete finding$/i })).toBeInTheDocument();
    });

    it('does not render pencil + trash buttons when projectId/pr are missing (degraded mode)', () => {
      const manualFinding = makeFinding({
        id: 'manual-1',
        title: 'Manual finding — no project context',
        source: 'manual',
        authoredAt: '2024-01-02T00:00:00Z',
      });

      render(
        <I18nWrapper>
          <FindingItem
            finding={manualFinding}
            selected={false}
            onToggle={vi.fn()}
            // projectId & pr deliberately omitted
          />
        </I18nWrapper>,
      );

      // Source badge still renders (read-only fallback)…
      expect(screen.getByText('Manual')).toBeInTheDocument();
      // …but the inline actions are suppressed.
      expect(screen.queryByRole('button', { name: /^edit finding$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^delete finding$/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Select all includes manual findings
  // -------------------------------------------------------------------------
  describe('Select all', () => {
    it('selects BOTH AI and manual findings when "Select all" is clicked', () => {
      const aiCritical = makeFinding({
        id: 'ai-1',
        severity: 'critical',
        title: 'AI critical issue',
      });
      const aiHigh = makeFinding({
        id: 'ai-2',
        severity: 'high',
        title: 'AI high issue',
      });
      const manualMedium = makeFinding({
        id: 'manual-1',
        severity: 'medium',
        title: 'Manual medium issue',
        source: 'manual',
        authoredAt: '2024-01-02T00:00:00Z',
      });
      const terminalLow = makeFinding({
        id: 'manual-2',
        severity: 'low',
        title: 'Terminal low issue',
        source: 'terminal',
        authoredAt: '2024-01-03T00:00:00Z',
      });

      const onSelectionChange = vi.fn();

      render(
        <I18nWrapper>
          <ReviewFindings
            findings={[aiCritical, aiHigh]}
            manualFindings={[manualMedium, terminalLow]}
            selectedIds={new Set()}
            onSelectionChange={onSelectionChange}
          />
        </I18nWrapper>,
      );

      const selectAllButton = screen.getByRole('button', { name: /^select all$/i });
      fireEvent.click(selectAllButton);

      expect(onSelectionChange).toHaveBeenCalledTimes(1);
      const passedSet = onSelectionChange.mock.calls[0][0] as Set<string>;
      // The contract is that ALL four findings — across both sources — are
      // selected.
      expect(passedSet.has('ai-1')).toBe(true);
      expect(passedSet.has('ai-2')).toBe(true);
      expect(passedSet.has('manual-1')).toBe(true);
      expect(passedSet.has('manual-2')).toBe(true);
      expect(passedSet.size).toBe(4);
    });

    it('"Select Critical/High" picks both AI and manual findings whose severity is critical/high', () => {
      // The "important" shortcut keys off severity, NOT source. Both AI
      // critical and manual high should be selected; lower-severity findings
      // (regardless of source) stay unselected.
      const aiCritical = makeFinding({
        id: 'ai-1',
        severity: 'critical',
        title: 'AI critical',
      });
      const manualHigh = makeFinding({
        id: 'manual-1',
        severity: 'high',
        title: 'Manual high',
        source: 'manual',
        authoredAt: '2024-01-02T00:00:00Z',
      });

      const onSelectionChange = vi.fn();

      render(
        <I18nWrapper>
          <ReviewFindings
            findings={[aiCritical]}
            manualFindings={[manualHigh]}
            selectedIds={new Set()}
            onSelectionChange={onSelectionChange}
          />
        </I18nWrapper>,
      );

      // The button label is "Select Blocker/Required (N)" via i18n
      // (the production copy uses the friendlier "Blocker"/"Required" labels
      // rather than the raw severity values).
      const importantButton = screen.getByRole('button', { name: /blocker\/required/i });
      fireEvent.click(importantButton);

      const passedSet = onSelectionChange.mock.calls[0][0] as Set<string>;
      expect(passedSet.has('ai-1')).toBe(true);
      // The manual high finding IS selected — Select Critical/High includes
      // both AI and manual findings whose severity falls in the bucket.
      expect(passedSet.has('manual-1')).toBe(true);
      expect(passedSet.size).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Merged ordering — AI findings lead each severity bucket
  // -------------------------------------------------------------------------
  describe('merged ordering', () => {
    it('places AI findings before manual findings within the same severity bucket', () => {
      const manualHigh = makeFinding({
        id: 'manual-1',
        severity: 'high',
        title: 'MANUAL high authored first',
        source: 'manual',
        authoredAt: '2024-01-01T00:00:00Z',
      });
      const aiHigh = makeFinding({
        id: 'ai-1',
        severity: 'high',
        title: 'AI high finding',
      });

      render(
        <I18nWrapper>
          <ReviewFindings
            findings={[aiHigh]}
            manualFindings={[manualHigh]}
            selectedIds={new Set()}
            onSelectionChange={vi.fn()}
          />
        </I18nWrapper>,
      );

      // Both rows render — the AI one should come first within the high group
      // because the comparator sorts ai-source ahead of manual-source.
      const aiTitle = screen.getByText('AI high finding');
      const manualTitle = screen.getByText('MANUAL high authored first');
      // compareDocumentPosition returns a bitmask; "4" (FOLLOWING) means the
      // second node comes after the first in document order.
      expect(aiTitle.compareDocumentPosition(manualTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 5. Empty state — no AI findings + no manual findings
  // -------------------------------------------------------------------------
  describe('empty state', () => {
    it('shows the "no issues found" placeholder only when both arrays are empty', () => {
      const { container, rerender } = render(
        <I18nWrapper>
          <ReviewFindings
            findings={[]}
            manualFindings={[]}
            selectedIds={new Set()}
            onSelectionChange={vi.fn()}
          />
        </I18nWrapper>,
      );

      // The empty-state copy is set by `prReview.noIssuesFound`.
      expect(within(container).getByText(/no issues found/i)).toBeInTheDocument();

      // Add one manual finding — empty state should disappear.
      // Use severity 'high' so the row is in a section expanded by default
      // (critical and high are expanded; medium/low are collapsed).
      rerender(
        <I18nWrapper>
          <ReviewFindings
            findings={[]}
            manualFindings={[
              makeFinding({
                id: 'manual-1',
                severity: 'high',
                title: 'A solo manual finding',
                source: 'manual',
                authoredAt: '2024-01-02T00:00:00Z',
              }),
            ]}
            selectedIds={new Set()}
            onSelectionChange={vi.fn()}
          />
        </I18nWrapper>,
      );

      expect(within(container).queryByText(/no issues found/i)).not.toBeInTheDocument();
      expect(within(container).getByText('A solo manual finding')).toBeInTheDocument();
    });
  });
});
