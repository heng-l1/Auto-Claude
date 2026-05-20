/**
 * @vitest-environment jsdom
 */
/**
 * Unit tests for AddManualFindingDialog component
 *
 * Verifies the three behaviors called out in the spec's QA acceptance criteria:
 *   1. Required-field validation gates the submit button until severity, title,
 *      file, line, and description all have non-empty values.
 *   2. The file autocomplete popover lists only the PR's changed files (sourced
 *      from `pr.files`), not arbitrary repo paths.
 *   3. Pressing Cmd/Ctrl+Enter from any field inside the form submits — calling
 *      the store's `addManualFinding` action with the typed values.
 *
 * The dialog reaches into `usePRReviewStore` for its mutation actions. We mock
 * that store at the module level (the same idiom used for IPC-bound hooks
 * elsewhere) so the assertions can target the spy directly, without driving an
 * end-to-end IPC roundtrip.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../../../../shared/i18n';
import type { PRData } from '../../../../../preload/api/modules/github-api';
import type { ManualPRReviewFinding } from '../../../../../shared/types/pr-review-comments';

// ---------------------------------------------------------------------------
// Store mock — must be hoisted above the SUT import, since the dialog binds to
// `usePRReviewStore` at module-evaluation time.
// ---------------------------------------------------------------------------

const mockAddManualFinding = vi.fn<
  (projectId: string, prNumber: number, payload: Partial<ManualPRReviewFinding>) =>
    Promise<ManualPRReviewFinding | null>
>();
const mockUpdateManualFinding = vi.fn<
  (
    projectId: string,
    prNumber: number,
    id: string,
    patch: Partial<ManualPRReviewFinding>,
  ) => Promise<ManualPRReviewFinding | null>
>();

vi.mock('../../../../stores/github/pr-review-store', () => ({
  // `usePRReviewStore` is called as a selector (`store(s => s.addManualFinding)`).
  // Simulate that by routing the selector through a stub state object.
  usePRReviewStore: (selector: (state: unknown) => unknown) =>
    selector({
      addManualFinding: mockAddManualFinding,
      updateManualFinding: mockUpdateManualFinding,
    }),
}));

// SUT import comes AFTER the mock so the store selector sees the mocked module.
import { AddManualFindingDialog } from '../AddManualFindingDialog';

function I18nWrapper({ children }: { children: React.ReactNode }) {
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}

function createMockPR(overrides: Partial<PRData> = {}): PRData {
  return {
    number: 142,
    title: 'Test PR',
    body: '',
    state: 'open',
    author: { login: 'reviewer' },
    headRefName: 'feature',
    baseRefName: 'main',
    additions: 10,
    deletions: 2,
    changedFiles: 2,
    assignees: [],
    files: [
      { path: 'src/foo/bar.ts', additions: 5, deletions: 1, status: 'modified' },
      { path: 'src/foo/qux.ts', additions: 5, deletions: 1, status: 'added' },
    ],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    htmlUrl: 'https://github.com/test/repo/pull/142',
    isDraft: false,
    ...overrides,
  };
}

function renderDialog(overrides: {
  pr?: PRData;
  initialValues?: Partial<ManualPRReviewFinding>;
  editingId?: string;
  onOpenChange?: (open: boolean) => void;
  onSubmitted?: (f: ManualPRReviewFinding | null) => void;
} = {}) {
  const onOpenChange = overrides.onOpenChange ?? vi.fn();
  const onSubmitted = overrides.onSubmitted ?? vi.fn();
  const pr = overrides.pr ?? createMockPR();
  const result = render(
    <I18nWrapper>
      <AddManualFindingDialog
        open
        onOpenChange={onOpenChange}
        projectId="proj-1"
        pr={pr}
        editingId={overrides.editingId}
        initialValues={overrides.initialValues}
        onSubmitted={onSubmitted}
      />
    </I18nWrapper>,
  );
  return { ...result, onOpenChange, onSubmitted, pr };
}

describe('AddManualFindingDialog', () => {
  beforeEach(() => {
    mockAddManualFinding.mockReset();
    mockUpdateManualFinding.mockReset();
    // Default: resolve to a plausible hydrated finding so the success branch runs.
    mockAddManualFinding.mockResolvedValue({
      id: 'manual-2024-01-01-abc123',
      severity: 'high',
      category: 'quality',
      title: 'Test',
      description: 'Test description',
      file: 'src/foo/bar.ts',
      line: 42,
      fixable: false,
      source: 'manual',
      authoredAt: '2024-01-01T00:00:00Z',
    });
  });

  afterEach(() => {
    cleanup();
  });

  // -------------------------------------------------------------------------
  // 1. Required-field validation
  // -------------------------------------------------------------------------
  describe('required-field validation', () => {
    it('disables the submit button when required fields are empty', () => {
      renderDialog();

      const submitButton = screen.getByRole('button', { name: /add finding/i });
      // Severity defaults to medium, but title/file/line/description are empty.
      expect(submitButton).toBeDisabled();
    });

    it('keeps submit disabled until ALL required fields are filled', () => {
      renderDialog();

      const submitButton = screen.getByRole('button', { name: /add finding/i });
      const titleInput = screen.getByLabelText(/^title/i);
      const fileInput = screen.getByLabelText(/^file/i);
      const lineInput = screen.getByLabelText(/^line/i);
      const descriptionInput = screen.getByLabelText(/^description/i);

      // Title only — still disabled
      fireEvent.change(titleInput, { target: { value: 'My finding' } });
      expect(submitButton).toBeDisabled();

      // Title + file — still disabled
      fireEvent.change(fileInput, { target: { value: 'src/foo/bar.ts' } });
      expect(submitButton).toBeDisabled();

      // Title + file + line — still disabled (description missing)
      fireEvent.change(lineInput, { target: { value: '42' } });
      expect(submitButton).toBeDisabled();

      // All four filled — finally enabled
      fireEvent.change(descriptionInput, { target: { value: 'Detailed explanation' } });
      expect(submitButton).toBeEnabled();
    });

    it('treats whitespace-only values as empty (cannot submit "   ")', () => {
      renderDialog();

      const submitButton = screen.getByRole('button', { name: /add finding/i });
      const titleInput = screen.getByLabelText(/^title/i);
      const fileInput = screen.getByLabelText(/^file/i);
      const lineInput = screen.getByLabelText(/^line/i);
      const descriptionInput = screen.getByLabelText(/^description/i);

      fireEvent.change(titleInput, { target: { value: '   ' } });
      fireEvent.change(fileInput, { target: { value: '   ' } });
      fireEvent.change(lineInput, { target: { value: '42' } });
      fireEvent.change(descriptionInput, { target: { value: '   ' } });

      // .trim() in the validator should reject whitespace-only strings.
      expect(submitButton).toBeDisabled();
    });

    it('does not call addManualFinding when submit is attempted without required fields', () => {
      renderDialog();

      const submitButton = screen.getByRole('button', { name: /add finding/i });
      // Click should be a no-op due to disabled attribute, but exercise the path.
      fireEvent.click(submitButton);

      expect(mockAddManualFinding).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 2. File autocomplete shows PR files only
  // -------------------------------------------------------------------------
  describe('file autocomplete', () => {
    it('shows the suggestions popover only with paths drawn from pr.files', () => {
      const pr = createMockPR({
        files: [
          { path: 'src/alpha/one.ts', additions: 1, deletions: 0, status: 'added' },
          { path: 'src/beta/two.ts', additions: 1, deletions: 0, status: 'added' },
          { path: 'tests/three.spec.ts', additions: 1, deletions: 0, status: 'added' },
        ],
      });
      renderDialog({ pr });

      const fileInput = screen.getByLabelText(/^file/i);
      fireEvent.focus(fileInput);

      // All three PR files are surfaced.
      expect(screen.getByRole('option', { name: 'src/alpha/one.ts' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'src/beta/two.ts' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'tests/three.spec.ts' })).toBeInTheDocument();

      // No options outside the PR's changed-file set.
      const listbox = screen.getByRole('listbox');
      const options = within(listbox).getAllByRole('option');
      expect(options).toHaveLength(3);
      const paths = options.map((o) => o.textContent);
      expect(paths).toEqual(['src/alpha/one.ts', 'src/beta/two.ts', 'tests/three.spec.ts']);
    });

    it('filters the suggestions by substring match against the typed text', () => {
      const pr = createMockPR({
        files: [
          { path: 'src/alpha/one.ts', additions: 1, deletions: 0, status: 'added' },
          { path: 'src/beta/two.ts', additions: 1, deletions: 0, status: 'added' },
          { path: 'tests/three.spec.ts', additions: 1, deletions: 0, status: 'added' },
        ],
      });
      renderDialog({ pr });

      const fileInput = screen.getByLabelText(/^file/i);
      fireEvent.focus(fileInput);
      fireEvent.change(fileInput, { target: { value: 'beta' } });

      // Only the path matching "beta" remains.
      const listbox = screen.getByRole('listbox');
      const options = within(listbox).getAllByRole('option');
      expect(options).toHaveLength(1);
      expect(options[0].textContent).toBe('src/beta/two.ts');
      // Make sure non-matching paths really are gone.
      expect(
        within(listbox).queryByRole('option', { name: 'src/alpha/one.ts' }),
      ).not.toBeInTheDocument();
    });

    it('selecting a suggestion writes the path into the file input', () => {
      renderDialog();

      const fileInput = screen.getByLabelText(/^file/i) as HTMLInputElement;
      fireEvent.focus(fileInput);
      const suggestion = screen.getByRole('option', { name: 'src/foo/qux.ts' });
      // The component uses mouseDown to prevent input blur, then click to commit.
      fireEvent.mouseDown(suggestion);
      fireEvent.click(suggestion);

      expect(fileInput.value).toBe('src/foo/qux.ts');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Cmd/Ctrl+Enter submits the form
  // -------------------------------------------------------------------------
  describe('keyboard submission', () => {
    function fillRequiredFields() {
      const titleInput = screen.getByLabelText(/^title/i);
      const fileInput = screen.getByLabelText(/^file/i);
      const lineInput = screen.getByLabelText(/^line/i);
      const descriptionInput = screen.getByLabelText(/^description/i);

      fireEvent.change(titleInput, { target: { value: 'Race condition in worker' } });
      fireEvent.change(fileInput, { target: { value: 'src/foo/bar.ts' } });
      fireEvent.change(lineInput, { target: { value: '88' } });
      fireEvent.change(descriptionInput, {
        target: { value: 'The mutex is released before the read completes.' },
      });
      return { titleInput, fileInput, lineInput, descriptionInput };
    }

    it('submits when Cmd+Enter is pressed inside the description textarea', async () => {
      renderDialog();

      const { descriptionInput } = fillRequiredFields();

      fireEvent.keyDown(descriptionInput, { key: 'Enter', metaKey: true });

      // Wait a microtask so the async handleSubmit can run.
      await Promise.resolve();
      await Promise.resolve();

      expect(mockAddManualFinding).toHaveBeenCalledTimes(1);
      const [projectId, prNumber, payload] = mockAddManualFinding.mock.calls[0];
      expect(projectId).toBe('proj-1');
      expect(prNumber).toBe(142);
      expect(payload).toMatchObject({
        severity: 'medium', // default
        category: 'quality', // default
        title: 'Race condition in worker',
        file: 'src/foo/bar.ts',
        line: 88,
        description: 'The mutex is released before the read completes.',
        fixable: false,
      });
    });

    it('submits when Ctrl+Enter is pressed inside the title input', async () => {
      renderDialog();

      const { titleInput } = fillRequiredFields();

      fireEvent.keyDown(titleInput, { key: 'Enter', ctrlKey: true });

      await Promise.resolve();
      await Promise.resolve();

      expect(mockAddManualFinding).toHaveBeenCalledTimes(1);
    });

    it('does NOT submit when plain Enter is pressed in a single-line input', async () => {
      renderDialog();

      const { titleInput } = fillRequiredFields();

      // Plain Enter (no Cmd/Ctrl) should advance focus, not submit.
      fireEvent.keyDown(titleInput, { key: 'Enter' });

      await Promise.resolve();
      await Promise.resolve();

      expect(mockAddManualFinding).not.toHaveBeenCalled();
    });

    it('does not submit when required fields are missing even with Cmd+Enter', async () => {
      renderDialog();

      const titleInput = screen.getByLabelText(/^title/i);
      fireEvent.change(titleInput, { target: { value: 'Only a title' } });

      fireEvent.keyDown(titleInput, { key: 'Enter', metaKey: true });

      await Promise.resolve();
      await Promise.resolve();

      expect(mockAddManualFinding).not.toHaveBeenCalled();
    });
  });
});
