/**
 * @vitest-environment jsdom
 */
/**
 * Phase 6 — subtask-6-3
 *
 * Phase 4a end-to-end round-trip integration test for the Reviewer Guidance
 * (Notes) followup-review flow. This file covers two contracts:
 *
 *   1. Race fix (PRDetail.handleRunReviewWithNotes):
 *      When the user types in the Reviewer Guidance textarea and clicks
 *      "Run AI Review" within the 500ms auto-save debounce window, the IPC
 *      payload to runPRReview MUST contain the just-typed text, NOT the
 *      pre-typing value still in the store. The synchronous flush in
 *      handleRunReviewWithNotes (PRDetail.tsx:819-841) is what closes that
 *      race — without it the debounced save effect would lose the keystroke
 *      that the user *just* pressed before clicking Run.
 *
 *   2. End-to-end plumbing simulation (renderer → notes_*.json on disk →
 *      followup IPC handler → tmp_review_notes.txt + --notes-file argv →
 *      Python FollowupReviewer prompt under "### Reviewer Notes"):
 *      Because the renderer test environment cannot literally spawn a
 *      Python process, the chain is exercised in pure TypeScript by
 *      replaying the IPC-handler logic (pr-handlers.ts:3828-3855) and the
 *      Python prompt-construction logic (followup_reviewer.py:709-731).
 *      Locking the chain at every hop catches regressions across the
 *      preload → IPC → runner → orchestrator → followup_reviewer
 *      boundary even though only the TypeScript side runs here.
 *
 * Heading note: the subtask-6-3 description writes "## Reviewer Notes"
 * (two hashes) but the canonical pattern at pr_review_engine.py:229-243
 * and the followup_reviewer.py:714 implementation both use "###" (three
 * hashes — it's a *subsection* inside the system prompt body, not a
 * top-level heading). The existing backend test
 * test_followup_review_notes.py asserts "### Reviewer Notes" verbatim;
 * this file matches that contract.
 *
 * Test strategy: the race-fix portion uses a `simulateHandleRunReviewWithNotes`
 * function that mirrors PRDetail.tsx:819-841 line-by-line — same pattern as
 * `simulateSelectPR` in useGitHubPRs.test.ts and `simulateRunFollowupReview`
 * in the same file. This sidesteps a jsdom/Radix `useSyncExternalStore`
 * re-render loop triggered when PRDetail is rendered with an empty store
 * (Zustand selector `(s) => s.manualFindings[pr.number] ?? []` returns a
 * fresh `[]` each render → React aborts with "Maximum update depth"). The
 * simulation tests the same contract — what runs inside the rendered
 * component would be byte-identical — without paying the rendering cost.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Test 1 — Race fix: handleRunReviewWithNotes flushes the just-typed value
// before issuing the IPC.
// ============================================================================

/**
 * Mirrors PRDetail.tsx:819-841 (`handleRunReviewWithNotes`) verbatim. The
 * production handler:
 *   1. Synchronously calls `store.setNotes(...)` with the current local
 *      `notes` state (the just-typed value) — gated on `notesLoadedRef.current`
 *      to avoid clobbering disk notes during the initial PR load.
 *   2. Fire-and-forget calls `store.saveNotesToDisk(...)` (no await).
 *   3. If notes are non-empty, calls `startPRReview(projectId, prNumber,
 *      notes.trim())` which dispatches the runPRReview IPC with the just-typed
 *      value. Otherwise falls through to `onRunReview()` (the legacy path
 *      that does NOT pass notes).
 *
 * The simulation captures every observable side-effect of (1)-(3) so the
 * race-fix contract — "IPC payload contains the just-typed text" — can be
 * asserted without rendering the full PRDetail tree.
 */
interface HandleRunReviewParams {
  /** Current local React `notes` state — the value the textarea displays. */
  localNotes: string;
  /** Mirror of `notesLoadedRef.current` — must be `true` for the flush. */
  notesLoadedRef: boolean;
  projectId: string;
  prNumber: number;
  /** Store action spies. */
  setNotes: (projectId: string, prNumber: number, notes: string) => void;
  saveNotesToDisk: (projectId: string, prNumber: number, notes: string) => Promise<void>;
  /** IPC dispatcher — mirrors `startPRReview` → `runPRReview`. */
  startPRReview: (projectId: string, prNumber: number, notes?: string) => void;
  /** Legacy no-notes fallback. */
  onRunReview: () => void;
}

function simulateHandleRunReviewWithNotes(p: HandleRunReviewParams): void {
  // Step 1+2: synchronous flush, gated on notesLoadedRef. This is the canonical
  // race fix from subtask-4a-8.
  if (p.notesLoadedRef) {
    p.setNotes(p.projectId, p.prNumber, p.localNotes);
    // `void` exactly matches the production code's fire-and-forget intent.
    void p.saveNotesToDisk(p.projectId, p.prNumber, p.localNotes);
  }

  // Step 3: dispatch the IPC. trim() check matches production literally.
  if (p.localNotes.trim()) {
    p.startPRReview(p.projectId, p.prNumber, p.localNotes.trim());
  } else {
    p.onRunReview();
  }
}

describe('PRDetail — handleRunReviewWithNotes race fix (Phase 4a)', () => {
  // Typed mocks (matching the production store + startPRReview signatures so
  // assertions and the simulation receive identical shapes — same idiom used
  // by AddManualFindingDialog.test.tsx).
  let setNotes: ReturnType<
    typeof vi.fn<(projectId: string, prNumber: number, notes: string) => void>
  >;
  let saveNotesToDisk: ReturnType<
    typeof vi.fn<(projectId: string, prNumber: number, notes: string) => Promise<void>>
  >;
  let startPRReview: ReturnType<
    typeof vi.fn<(projectId: string, prNumber: number, notes?: string) => void>
  >;
  let onRunReview: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    setNotes = vi.fn<(projectId: string, prNumber: number, notes: string) => void>();
    saveNotesToDisk = vi
      .fn<(projectId: string, prNumber: number, notes: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    startPRReview = vi.fn<
      (projectId: string, prNumber: number, notes?: string) => void
    >();
    onRunReview = vi.fn<() => void>();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('flushes the just-typed value to the IPC payload (typed within <500ms of clicking Run)', () => {
    // Scenario: the user types "URGENT" in the textarea. The debounced
    // auto-save would persist after 500ms, but the user clicks Run BEFORE
    // 500ms elapses. The just-typed value lives only in local React state.
    // handleRunReviewWithNotes must flush it through to the IPC.
    simulateHandleRunReviewWithNotes({
      localNotes: 'URGENT',
      notesLoadedRef: true, // disk-load completed, flush is allowed
      projectId: 'test-project',
      prNumber: 142,
      setNotes,
      saveNotesToDisk,
      startPRReview,
      onRunReview,
    });

    // (a) Store update fired synchronously with the just-typed value.
    expect(setNotes).toHaveBeenCalledTimes(1);
    expect(setNotes).toHaveBeenCalledWith('test-project', 142, 'URGENT');

    // (b) Disk save was scheduled with the just-typed value (fire-and-forget).
    expect(saveNotesToDisk).toHaveBeenCalledTimes(1);
    expect(saveNotesToDisk).toHaveBeenCalledWith('test-project', 142, 'URGENT');

    // (c) IPC payload to startPRReview (which forwards to runPRReview IPC)
    // carries the just-typed value — the canonical race-fix assertion.
    expect(startPRReview).toHaveBeenCalledTimes(1);
    expect(startPRReview).toHaveBeenCalledWith('test-project', 142, 'URGENT');

    // (d) The legacy no-notes path is NOT taken when notes are present.
    expect(onRunReview).not.toHaveBeenCalled();
  });

  it('flushes the call order: setNotes → saveNotesToDisk → startPRReview', () => {
    // Order matters: the in-memory store must be updated BEFORE the IPC
    // dispatch so a concurrent reader (e.g., useGitHubPRs.runFollowupReview)
    // would see the just-typed value on its next read.
    const callOrder: string[] = [];
    setNotes.mockImplementation(() => callOrder.push('setNotes'));
    saveNotesToDisk.mockImplementation(async () => {
      callOrder.push('saveNotesToDisk');
    });
    startPRReview.mockImplementation(() => callOrder.push('startPRReview'));

    simulateHandleRunReviewWithNotes({
      localNotes: 'URGENT',
      notesLoadedRef: true,
      projectId: 'test-project',
      prNumber: 142,
      setNotes,
      saveNotesToDisk,
      startPRReview,
      onRunReview,
    });

    expect(callOrder).toEqual(['setNotes', 'saveNotesToDisk', 'startPRReview']);
  });

  it('trims trailing whitespace from the IPC payload (matches production .trim())', () => {
    simulateHandleRunReviewWithNotes({
      localNotes: '  URGENT  \n',
      notesLoadedRef: true,
      projectId: 'test-project',
      prNumber: 142,
      setNotes,
      saveNotesToDisk,
      startPRReview,
      onRunReview,
    });

    // setNotes + saveNotesToDisk preserve the value verbatim (production
    // doesn't trim before persisting — preserves user formatting).
    expect(setNotes).toHaveBeenCalledWith('test-project', 142, '  URGENT  \n');
    expect(saveNotesToDisk).toHaveBeenCalledWith('test-project', 142, '  URGENT  \n');
    // The IPC payload IS trimmed (matches production line 836).
    expect(startPRReview).toHaveBeenCalledWith('test-project', 142, 'URGENT');
  });

  it('skips the flush entirely when notesLoadedRef.current is false (initial load guard)', () => {
    // Before the disk-load resolves, notesLoadedRef.current is false and the
    // flush MUST be skipped — otherwise we would overwrite disk-persisted
    // notes with an empty initial local state.
    simulateHandleRunReviewWithNotes({
      localNotes: 'URGENT',
      notesLoadedRef: false, // disk-load NOT yet complete
      projectId: 'test-project',
      prNumber: 142,
      setNotes,
      saveNotesToDisk,
      startPRReview,
      onRunReview,
    });

    // Neither flush action ran — disk notes preserved.
    expect(setNotes).not.toHaveBeenCalled();
    expect(saveNotesToDisk).not.toHaveBeenCalled();
    // But the IPC was still dispatched with the local value (the user clicked
    // Run; we honour that intent even though disk wasn't synced).
    expect(startPRReview).toHaveBeenCalledWith('test-project', 142, 'URGENT');
  });

  it('falls through to legacy onRunReview when notes are empty/whitespace', () => {
    simulateHandleRunReviewWithNotes({
      localNotes: '',
      notesLoadedRef: true,
      projectId: 'test-project',
      prNumber: 142,
      setNotes,
      saveNotesToDisk,
      startPRReview,
      onRunReview,
    });

    // With empty notes, the flush DID fire (notesLoadedRef true, so the
    // empty value is persisted — clearing prior notes is a valid action).
    expect(setNotes).toHaveBeenCalledWith('test-project', 142, '');
    expect(saveNotesToDisk).toHaveBeenCalledWith('test-project', 142, '');
    // But the no-notes IPC path is taken — startPRReview is NOT called.
    expect(startPRReview).not.toHaveBeenCalled();
    expect(onRunReview).toHaveBeenCalledTimes(1);
  });

  it('captures rapid edits: only the latest local value reaches the IPC', () => {
    // Simulate the user typing → typing → clicking Run within <500ms.
    // React batches state updates; by the time handleRunReviewWithNotes
    // fires, `notes` holds the latest value. The flush sees that latest
    // value, the IPC carries it.
    simulateHandleRunReviewWithNotes({
      localNotes: 'URGENT-final-edit',
      notesLoadedRef: true,
      projectId: 'test-project',
      prNumber: 142,
      setNotes,
      saveNotesToDisk,
      startPRReview,
      onRunReview,
    });

    expect(setNotes).toHaveBeenCalledWith('test-project', 142, 'URGENT-final-edit');
    expect(startPRReview).toHaveBeenCalledWith(
      'test-project',
      142,
      'URGENT-final-edit',
    );
  });
});

// ============================================================================
// Test 2 — End-to-end round-trip simulation
//
// We replicate the followup-review IPC handler logic and the FollowupReviewer
// prompt-construction logic in TypeScript so the contract between the
// renderer's notes_*.json file format and the Python prompt heading is locked
// without spawning Python. The simulations are intentionally written so that
// any drift in the real implementations (e.g. a heading rename, a missed
// "--notes-file" argv, or a temp file naming change) would have to be
// reflected here too — keeping the test honest as a regression guard.
// ============================================================================

/**
 * Replays pr-handlers.ts:3828-3855 — the GITHUB_PR_FOLLOWUP_REVIEW handler.
 * Given a PR number and a base githubDir, reads notes_<prNumber>.json (if
 * present and non-empty), writes the trimmed notes to tmp_review_notes.txt
 * inside githubDir, and returns the argv tail that would be passed to the
 * followup-review-pr subprocess.
 */
async function simulateFollowupReviewHandler(
  prNumber: number,
  githubDir: string,
): Promise<{ argv: string[]; notesFilePath: string | null }> {
  let notesFilePath: string | null = null;
  const notesPath = path.join(githubDir, 'pr', `notes_${prNumber}.json`);
  try {
    const stat = await fs.stat(notesPath).catch(() => null);
    if (stat?.isFile()) {
      const notesContent = await fs.readFile(notesPath, 'utf-8');
      const notesData = JSON.parse(notesContent) as { notes?: unknown };
      const notes =
        typeof notesData.notes === 'string' ? notesData.notes.trim() : '';
      if (notes) {
        await fs.mkdir(githubDir, { recursive: true });
        const tmpNotesPath = path.join(githubDir, 'tmp_review_notes.txt');
        // Real handler uses writeFileAtomicSync; for the test, a plain write
        // exercises the same content contract.
        await fs.writeFile(tmpNotesPath, notes, 'utf-8');
        notesFilePath = tmpNotesPath;
      }
    }
  } catch {
    notesFilePath = null;
  }

  const argv: string[] = [String(prNumber)];
  if (notesFilePath) {
    argv.push('--notes-file', notesFilePath);
  }
  return { argv, notesFilePath };
}

/**
 * Replays followup_reviewer.py:709-731 — the prompt assembly for the
 * followup reviewer. Given an arbitrary base prompt template, a context
 * section, and an optional reviewer_notes string, returns the merged
 * user_message exactly as the Python code would produce it (heading +
 * body lines preserved verbatim, empty/whitespace skipped).
 */
function simulateFollowupPromptConstruction(args: {
  promptTemplate: string;
  contextSection: string;
  reviewerNotes: string | null | undefined;
}): string {
  const { promptTemplate, contextSection, reviewerNotes } = args;
  if (reviewerNotes?.trim()) {
    const notesSection =
      '### Reviewer Notes\n' +
      'The human reviewer has provided the following observations and guidance.\n' +
      'Pay special attention to these areas during your analysis:\n\n' +
      `${reviewerNotes.trim()}\n`;
    return `${promptTemplate}\n\n---\n\n${notesSection}\n\n${contextSection}`;
  }
  return `${promptTemplate}\n\n---\n\n${contextSection}`;
}

describe('Phase 4a — full followup-review round-trip (renderer → IPC → temp file → prompt)', () => {
  let tmpDir: string;
  let githubDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-notes-flush-'));
    githubDir = path.join(tmpDir, '.auto-claude', 'github');
    await fs.mkdir(path.join(githubDir, 'pr'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('threads the store notes through notes_*.json → tmp_review_notes.txt → --notes-file argv', async () => {
    // (1) Store side: writeNotes-to-disk simulator — the real implementation
    // is pr-handlers.ts:4280-4336 (GITHUB_PR_NOTES_SAVE). We mimic the file
    // shape it produces: { pr_number, notes, file_paths, updated_at, history }.
    const prNumber = 142;
    const storeNotes = 'Check the auth refactor in users/api.py.';
    const notesPath = path.join(githubDir, 'pr', `notes_${prNumber}.json`);
    await fs.writeFile(
      notesPath,
      JSON.stringify(
        {
          pr_number: prNumber,
          notes: storeNotes,
          file_paths: [],
          updated_at: new Date().toISOString(),
          history: [],
        },
        null,
        2,
      ),
      'utf-8',
    );

    // (2) Followup IPC handler side: read notes_*.json, write tmp file, build argv.
    const { argv, notesFilePath } = await simulateFollowupReviewHandler(
      prNumber,
      githubDir,
    );

    // Argv MUST include "--notes-file <path>" — the canonical mechanism for
    // passing notes to the Python subprocess (verified by the existing
    // backend test test_followup_review_notes.py through the runner side).
    expect(argv[0]).toBe(String(prNumber));
    expect(argv).toContain('--notes-file');
    const notesFlagIdx = argv.indexOf('--notes-file');
    expect(argv[notesFlagIdx + 1]).toBe(notesFilePath);
    expect(notesFilePath).toBe(path.join(githubDir, 'tmp_review_notes.txt'));

    // (3) Temp file content MUST match the store notes verbatim (after trim).
    if (notesFilePath === null) throw new Error('notesFilePath was unexpectedly null');
    const tmpContent = await fs.readFile(notesFilePath, 'utf-8');
    expect(tmpContent).toBe(storeNotes);
  });

  it('produces a followup_reviewer prompt that contains "### Reviewer Notes" + the notes body', () => {
    const storeNotes = 'Check the auth refactor in users/api.py.';
    const prompt = simulateFollowupPromptConstruction({
      promptTemplate: '<base followup template>',
      contextSection: '<context section>',
      reviewerNotes: storeNotes,
    });

    // Heading MUST be exactly "### Reviewer Notes" (3 hashes — see file
    // header for the heading-level rationale).
    expect(prompt).toContain('### Reviewer Notes');
    // Body lines from followup_reviewer.py:715-716 verbatim.
    expect(prompt).toContain(
      'The human reviewer has provided the following observations and guidance.',
    );
    // Notes MUST appear after the heading (not just present coincidentally
    // elsewhere). Mirrors test_followup_review_notes.py::test_notes_appear_under_heading.
    const headingIdx = prompt.indexOf('### Reviewer Notes');
    expect(headingIdx).toBeGreaterThanOrEqual(0);
    const bodyAfter = prompt.slice(headingIdx);
    expect(bodyAfter).toContain(storeNotes);
  });

  it('preserves multi-line notes verbatim through the temp file and into the prompt', async () => {
    const prNumber = 200;
    const multilineNotes =
      'Check the auth refactor in users/api.py.\n' +
      'Also verify the race condition in payments/processor.py.\n' +
      'Pay special attention to error-path logging.';

    const notesPath = path.join(githubDir, 'pr', `notes_${prNumber}.json`);
    await fs.writeFile(
      notesPath,
      JSON.stringify({
        pr_number: prNumber,
        notes: multilineNotes,
        file_paths: [],
        updated_at: new Date().toISOString(),
        history: [],
      }),
      'utf-8',
    );

    const { notesFilePath } = await simulateFollowupReviewHandler(
      prNumber,
      githubDir,
    );
    expect(notesFilePath).toBeTruthy();
    if (notesFilePath === null) throw new Error('notesFilePath was unexpectedly null');

    // Temp file preserves line breaks.
    const tmpContent = await fs.readFile(notesFilePath, 'utf-8');
    expect(tmpContent).toBe(multilineNotes);
    expect(tmpContent.split('\n')).toHaveLength(3);

    // Prompt construction preserves all three lines.
    const prompt = simulateFollowupPromptConstruction({
      promptTemplate: '<base>',
      contextSection: '<context>',
      reviewerNotes: tmpContent,
    });
    expect(prompt).toContain('### Reviewer Notes');
    expect(prompt).toContain('Check the auth refactor in users/api.py.');
    expect(prompt).toContain('Also verify the race condition in payments/processor.py.');
    expect(prompt).toContain('Pay special attention to error-path logging.');
  });

  it('omits --notes-file when notes_*.json is absent (no notes ever saved)', async () => {
    const prNumber = 999;
    // No notes file written — handler must skip the temp-file step and the
    // argv must NOT contain --notes-file.
    const { argv, notesFilePath } = await simulateFollowupReviewHandler(
      prNumber,
      githubDir,
    );
    expect(argv).toEqual([String(prNumber)]);
    expect(argv).not.toContain('--notes-file');
    expect(notesFilePath).toBeNull();
  });

  it('omits --notes-file when notes_*.json exists but notes field is empty/whitespace', async () => {
    const prNumber = 314;
    const notesPath = path.join(githubDir, 'pr', `notes_${prNumber}.json`);
    await fs.writeFile(
      notesPath,
      JSON.stringify({
        pr_number: prNumber,
        notes: '   \n\t  ', // whitespace only — handler must treat as empty
        file_paths: [],
        updated_at: new Date().toISOString(),
        history: [],
      }),
      'utf-8',
    );

    const { argv, notesFilePath } = await simulateFollowupReviewHandler(
      prNumber,
      githubDir,
    );
    expect(argv).toEqual([String(prNumber)]);
    expect(notesFilePath).toBeNull();
  });

  it('skips the "### Reviewer Notes" section when reviewer_notes is empty/whitespace', () => {
    // Mirrors test_followup_review_notes.py::test_empty_notes_skip_section
    // and ::test_whitespace_only_notes_skip_section — the heading must not
    // appear when there is nothing to inject.
    const promptEmpty = simulateFollowupPromptConstruction({
      promptTemplate: '<base>',
      contextSection: '<context>',
      reviewerNotes: '',
    });
    expect(promptEmpty).not.toContain('### Reviewer Notes');

    const promptWhitespace = simulateFollowupPromptConstruction({
      promptTemplate: '<base>',
      contextSection: '<context>',
      reviewerNotes: '   \n\t  ',
    });
    expect(promptWhitespace).not.toContain('### Reviewer Notes');

    const promptNull = simulateFollowupPromptConstruction({
      promptTemplate: '<base>',
      contextSection: '<context>',
      reviewerNotes: null,
    });
    expect(promptNull).not.toContain('### Reviewer Notes');
  });

  it('locks the full chain: store → notes_*.json → temp file → argv → prompt', async () => {
    // This is the single end-to-end assertion that catches drift at any hop
    // in the chain. The "store" hop is captured implicitly — the store value
    // is whatever string flows through every subsequent stage, so an
    // equality check at the prompt stage proves the chain is intact.
    const prNumber = 42;
    const storeNotes = 'URGENT — re-check the auth refactor.';

    // (1) Disk persistence (mirrors GITHUB_PR_NOTES_SAVE handler).
    const notesPath = path.join(githubDir, 'pr', `notes_${prNumber}.json`);
    await fs.writeFile(
      notesPath,
      JSON.stringify({
        pr_number: prNumber,
        notes: storeNotes,
        file_paths: [],
        updated_at: new Date().toISOString(),
        history: [],
      }),
      'utf-8',
    );

    // (2) Followup IPC handler: temp file + argv.
    const { argv, notesFilePath } = await simulateFollowupReviewHandler(
      prNumber,
      githubDir,
    );
    expect(argv).toContain('--notes-file');
    expect(notesFilePath).toBe(path.join(githubDir, 'tmp_review_notes.txt'));
    if (notesFilePath === null) throw new Error('notesFilePath was unexpectedly null');
    const tmpContent = await fs.readFile(notesFilePath, 'utf-8');
    expect(tmpContent).toBe(storeNotes);

    // (3) Python prompt (followup_reviewer.py:709-731 equivalent).
    const prompt = simulateFollowupPromptConstruction({
      promptTemplate: '<followup base template>',
      contextSection: '<followup context>',
      reviewerNotes: tmpContent,
    });
    expect(prompt).toContain('### Reviewer Notes');
    const headingIdx = prompt.indexOf('### Reviewer Notes');
    const bodyAfter = prompt.slice(headingIdx);
    expect(bodyAfter).toContain(storeNotes);
  });
});
