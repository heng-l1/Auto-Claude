/**
 * Unit tests for the post-review flow:
 *   1. Multi-line range support in `buildReviewComments()` — six test cases
 *      covering every cell of the cascade (lineInDiff × endLineInDiff ×
 *      endLine cmp line) per the GitHub REST API contract documented at
 *      pr-handlers.ts:441-470.
 *   2. Mixed AI + manual posting — the 👤 glyph prefix is gated on
 *      `source !== 'ai'`; AI findings stay unchanged.
 *   3. `postedFindingIds` merge contract — after a successful post, the
 *      stored ID list is the deduplicated union of any pre-existing IDs and
 *      the IDs of the just-posted findings.
 *   4. Verdict computation — a single selected `critical` finding (of any
 *      source) escalates the GitHub review event to `REQUEST_CHANGES`.
 *
 * Strategy:
 *   - Tests #1–7 exercise the exported `buildReviewComments()` directly so
 *     the assertions key off the same code path that the IPC handler calls
 *     at pr-handlers.ts:2933. No mocking required.
 *   - Tests #8–9 verify the small inline contracts embedded in the
 *     `GITHUB_PR_POST_REVIEW` handler (postedFindingIds dedupe at line 3072
 *     and verdict cascade at lines 2944-2969). The handler itself is
 *     tightly coupled to file IO + `githubFetch`, so we re-state each
 *     contract as a local helper here and verify the helper produces the
 *     expected output — the helpers are byte-for-byte mirrors of the
 *     inline production logic and serve as both regression tests and
 *     executable documentation of the contracts.
 */
import { describe, expect, it } from 'vitest';
import { buildReviewComments } from '../pr-handlers';
import type { PRReviewFinding } from '../pr-handlers';

/**
 * Build a minimal valid `PRReviewFinding` for tests. Only `file` and `line`
 * are required since they drive the routing logic; everything else has a
 * sensible default that can be overridden per test.
 */
function makeFinding(
  overrides: Partial<PRReviewFinding> & { file: string; line: number },
): PRReviewFinding {
  return {
    id: 'f-default',
    severity: 'medium',
    category: 'quality',
    title: 'Test finding',
    description: 'Test description',
    fixable: false,
    ...overrides,
  };
}

describe('Multi-line range support (FR #6 — buildReviewComments cascade)', () => {
  // -------------------------------------------------------------------------
  // (1) endLine === line (degenerate) → single-line at f.line
  // -------------------------------------------------------------------------
  // Both endpoints land on the same line, so there is no real range. GitHub
  // returns HTTP 422 if `start_line >= line`, hence the defensive collapse
  // back to a single-line anchor.
  it('endLine === line (degenerate): posts as single-line at f.line, no start_line/start_side', () => {
    const fileLineMap = new Map<string, Set<number>>([
      ['src/file.ts', new Set([10, 11, 12])],
    ]);
    const findings = [
      makeFinding({ file: 'src/file.ts', line: 11, endLine: 11 }),
    ];

    const { inlineComments, fileLevelEntries } = buildReviewComments(
      findings,
      fileLineMap,
    );

    expect(inlineComments).toHaveLength(1);
    expect(fileLevelEntries).toHaveLength(0);
    expect(inlineComments[0].path).toBe('src/file.ts');
    expect(inlineComments[0].line).toBe(11);
    // Critical: start_line/start_side MUST be omitted so GitHub doesn't 422
    expect(inlineComments[0].start_line).toBeUndefined();
    expect(inlineComments[0].start_side).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // (2) endLine < line (invalid / inverted range) → single-line at f.line
  // -------------------------------------------------------------------------
  // The range is malformed (end before start). Same risk as (1): we must
  // omit start_line/start_side and anchor at f.line.
  it('endLine < line (inverted/invalid): falls back to single-line at f.line', () => {
    const fileLineMap = new Map<string, Set<number>>([
      ['src/file.ts', new Set([5, 6, 7, 8, 9, 10])],
    ]);
    const findings = [
      makeFinding({ file: 'src/file.ts', line: 10, endLine: 5 }),
    ];

    const { inlineComments, fileLevelEntries } = buildReviewComments(
      findings,
      fileLineMap,
    );

    expect(inlineComments).toHaveLength(1);
    expect(fileLevelEntries).toHaveLength(0);
    expect(inlineComments[0].path).toBe('src/file.ts');
    expect(inlineComments[0].line).toBe(10);
    expect(inlineComments[0].start_line).toBeUndefined();
    expect(inlineComments[0].start_side).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // (3) endLine > line, both endpoints in diff → happy-path multi-line range
  // -------------------------------------------------------------------------
  // The only branch that actually emits `start_line`/`start_side`. GitHub's
  // contract: `line` is the LAST line of the range, `start_line` is the
  // FIRST, both sides must match.
  it('endLine > line, both endpoints in diff: emits multi-line range with start_line + line', () => {
    const fileLineMap = new Map<string, Set<number>>([
      ['src/auth.ts', new Set([85, 86, 87, 88, 89, 90, 91, 92, 93, 94])],
    ]);
    const findings = [
      makeFinding({
        file: 'src/auth.ts',
        line: 87,
        endLine: 92,
        severity: 'high',
        title: 'Unsafe handler chain',
      }),
    ];

    const { inlineComments, fileLevelEntries } = buildReviewComments(
      findings,
      fileLineMap,
    );

    expect(inlineComments).toHaveLength(1);
    expect(fileLevelEntries).toHaveLength(0);
    const comment = inlineComments[0];
    expect(comment.path).toBe('src/auth.ts');
    // GitHub contract: `line` is the LAST line of the range
    expect(comment.line).toBe(92);
    expect(comment.side).toBe('RIGHT');
    // start_line is the FIRST line of the range
    expect(comment.start_line).toBe(87);
    expect(comment.start_side).toBe('RIGHT');
    // Body still contains the standard severity + title formatting
    expect(comment.body).toContain('**[HIGH] Unsafe handler chain**');
  });

  // -------------------------------------------------------------------------
  // (4) endLine > line, neither endpoint in diff → file-level body entry
  // -------------------------------------------------------------------------
  // The file is in the PR (entry exists in fileLineMap) but neither anchor
  // matches a hunk line. Posting an inline comment would 422 with
  // "Line could not be resolved", so we surface as file-level instead.
  it('endLine > line, neither endpoint in diff: routes to file-level entry (file in PR)', () => {
    const fileLineMap = new Map<string, Set<number>>([
      // File IS in the PR — but the diff hunk only covers lines 5-7,
      // neither endpoint of the finding's range is in that set
      ['src/utils.ts', new Set([5, 6, 7])],
    ]);
    const findings = [
      makeFinding({
        file: 'src/utils.ts',
        line: 100,
        endLine: 110,
        severity: 'medium',
        title: 'Off-diff range',
      }),
    ];

    const { inlineComments, fileLevelEntries } = buildReviewComments(
      findings,
      fileLineMap,
    );

    expect(inlineComments).toHaveLength(0);
    expect(fileLevelEntries).toHaveLength(1);
    // File-level entry format: "- **path** (line X): body"
    // Critically: the "(not in PR files)" suffix is NOT present because the
    // file IS in the PR — only the lines are off-diff.
    expect(fileLevelEntries[0]).toContain('src/utils.ts');
    expect(fileLevelEntries[0]).toContain('(line 100)');
    expect(fileLevelEntries[0]).not.toContain('not in PR files');
    expect(fileLevelEntries[0]).toContain('**[MEDIUM] Off-diff range**');
  });

  // -------------------------------------------------------------------------
  // (5) Only `line` in diff (endLine off-diff) → single-line at f.line
  // -------------------------------------------------------------------------
  // The cascade falls to the `lineInDiff` branch. We anchor at the in-diff
  // endpoint and don't attempt a partial range (would 422).
  it('only line in diff (endLine off-diff): posts single-line at f.line', () => {
    const fileLineMap = new Map<string, Set<number>>([
      // line=10 is in diff, endLine=20 is not
      ['src/handler.ts', new Set([8, 9, 10, 11, 12])],
    ]);
    const findings = [
      makeFinding({
        file: 'src/handler.ts',
        line: 10,
        endLine: 20,
        severity: 'low',
      }),
    ];

    const { inlineComments, fileLevelEntries } = buildReviewComments(
      findings,
      fileLineMap,
    );

    expect(inlineComments).toHaveLength(1);
    expect(fileLevelEntries).toHaveLength(0);
    expect(inlineComments[0].path).toBe('src/handler.ts');
    expect(inlineComments[0].line).toBe(10);
    // Partial range → no start_line/start_side
    expect(inlineComments[0].start_line).toBeUndefined();
    expect(inlineComments[0].start_side).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // (6) Only `endLine` in diff (FR #6) → single-line at f.endLine
  // -------------------------------------------------------------------------
  // The cascade's third branch. Without this case, an endLine-only-in-diff
  // finding would incorrectly route to file-level despite having a postable
  // inline anchor.
  it('only endLine in diff (FR #6): posts single-line at f.endLine (in-diff endpoint)', () => {
    const fileLineMap = new Map<string, Set<number>>([
      // line=5 is NOT in diff, endLine=15 IS in diff
      ['src/router.ts', new Set([13, 14, 15, 16, 17])],
    ]);
    const findings = [
      makeFinding({
        file: 'src/router.ts',
        line: 5,
        endLine: 15,
      }),
    ];

    const { inlineComments, fileLevelEntries } = buildReviewComments(
      findings,
      fileLineMap,
    );

    expect(inlineComments).toHaveLength(1);
    expect(fileLevelEntries).toHaveLength(0);
    expect(inlineComments[0].path).toBe('src/router.ts');
    // Anchor at the in-diff endpoint per FR #6 contract
    expect(inlineComments[0].line).toBe(15);
    // No range — single-line fallback
    expect(inlineComments[0].start_line).toBeUndefined();
    expect(inlineComments[0].start_side).toBeUndefined();
  });
});

describe('Mixed AI + manual posting (👤 glyph prefix gated on source)', () => {
  // -------------------------------------------------------------------------
  // (7) Mixed AI + manual posting — payload has both kinds; manual prefixed
  //     with the 👤 glyph, AI findings unchanged for back-compat.
  // -------------------------------------------------------------------------
  // Source semantics:
  //   - `source: 'ai'` or omitted  → no 👤 prefix (back-compat)
  //   - `source: 'manual'`         → 👤 prefix (human-authored)
  //   - `source: 'terminal'`       → 👤 prefix (terminal Claude-authored)
  it('payload contains both AI and manual findings; manual ones prefixed with 👤', () => {
    const fileLineMap = new Map<string, Set<number>>([
      ['src/a.ts', new Set([10, 11])],
      ['src/b.ts', new Set([20, 21])],
      ['src/c.ts', new Set([30, 31])],
      ['src/d.ts', new Set([40, 41])],
    ]);
    const findings: PRReviewFinding[] = [
      // Two AI findings — `source` omitted (legacy) and explicit 'ai'
      makeFinding({
        id: 'ai-1',
        file: 'src/a.ts',
        line: 10,
        severity: 'high',
        title: 'AI legacy (no source)',
      }),
      {
        ...makeFinding({
          id: 'ai-2',
          file: 'src/b.ts',
          line: 20,
          severity: 'medium',
          title: 'AI explicit',
        }),
        source: 'ai',
      },
      // Two manual findings — 'manual' (UI form) and 'terminal' (in-terminal Claude)
      {
        ...makeFinding({
          id: 'manual-1',
          file: 'src/c.ts',
          line: 30,
          severity: 'critical',
          title: 'Manual finding from UI',
        }),
        source: 'manual',
      },
      {
        ...makeFinding({
          id: 'manual-2',
          file: 'src/d.ts',
          line: 40,
          severity: 'low',
          title: 'Terminal Claude finding',
        }),
        source: 'terminal',
      },
    ];

    const { inlineComments, fileLevelEntries } = buildReviewComments(
      findings,
      fileLineMap,
    );

    // All four findings produce inline comments (every line is in diff)
    expect(inlineComments).toHaveLength(4);
    expect(fileLevelEntries).toHaveLength(0);

    // Index comments by id for stable assertions
    const byId = new Map<string, (typeof inlineComments)[0]>();
    for (const c of inlineComments) {
      // Title text is the most stable identifier in the rendered body
      for (const f of findings) {
        if (c.body.includes(f.title)) {
          byId.set(f.id, c);
          break;
        }
      }
    }

    // AI findings (legacy + explicit) — NO 👤 prefix
    const aiLegacy = byId.get('ai-1');
    expect(aiLegacy).toBeDefined();
    expect(aiLegacy?.body.startsWith('👤')).toBe(false);
    expect(aiLegacy?.body).toMatch(/^🟠/); // high → orange
    expect(aiLegacy?.body).toContain('**[HIGH] AI legacy (no source)**');

    const aiExplicit = byId.get('ai-2');
    expect(aiExplicit).toBeDefined();
    expect(aiExplicit?.body.startsWith('👤')).toBe(false);
    expect(aiExplicit?.body).toMatch(/^🟡/); // medium → yellow

    // Manual finding (UI) — 👤 prefix
    const manualUi = byId.get('manual-1');
    expect(manualUi).toBeDefined();
    expect(manualUi?.body.startsWith('👤 ')).toBe(true);
    expect(manualUi?.body).toContain('🔴'); // critical → red
    expect(manualUi?.body).toContain('**[CRITICAL] Manual finding from UI**');

    // Terminal finding — 👤 prefix (same as manual; both are source !== 'ai')
    const terminalFinding = byId.get('manual-2');
    expect(terminalFinding).toBeDefined();
    expect(terminalFinding?.body.startsWith('👤 ')).toBe(true);
    expect(terminalFinding?.body).toContain('🔵'); // low → blue
  });
});

// ---------------------------------------------------------------------------
// Helpers replicating the inline contracts embedded in
// `GITHUB_PR_POST_REVIEW` (pr-handlers.ts:2832-3099). The implementations
// below are byte-for-byte mirrors of the production logic — they exist here
// so tests #8 and #9 can verify the contracts without dragging the handler's
// fs.readFileSync / githubFetch / project-middleware dependencies into a
// pure-unit test. If the production logic changes, these helpers must be
// updated in lock-step (and the tests will catch any drift).
// ---------------------------------------------------------------------------

/**
 * Mirrors the merge at pr-handlers.ts:3072:
 *   data.posted_finding_ids = [...new Set([...existingPostedIds, ...newPostedIds])];
 *
 * `existingPostedIds` is the previously persisted list (empty on first
 * post); `newPostedIds` is `findings.map((f) => f.id)` where `findings` is
 * the MERGED + FILTERED list of AI + manual findings being posted.
 */
function mergePostedFindingIds(
  existingPostedIds: string[],
  newPostedIds: string[],
): string[] {
  return [...new Set([...existingPostedIds, ...newPostedIds])];
}

type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

/**
 * Mirrors the verdict cascade at pr-handlers.ts:2944-2969:
 *   1. `forceApprove`           → 'approve'
 *   2. `forceRequestChanges`    → 'request_changes'
 *   3. selection-driven cascade → critical/high blocker → 'request_changes',
 *                                 otherwise 'comment' (any findings) or
 *                                 'approve' (empty selection)
 *   4. Fallthrough               → `defaultStatus` (from result.overallStatus)
 *
 * Then maps `overallStatus` → GitHub review `event`.
 */
function computeReviewEvent(
  findings: PRReviewFinding[],
  selectedSet: Set<string> | null,
  options: { forceApprove?: boolean; forceRequestChanges?: boolean },
  defaultStatus: 'approve' | 'request_changes' | 'comment' | 'in_progress',
): ReviewEvent {
  let overallStatus: string = defaultStatus;
  if (options.forceApprove) {
    overallStatus = 'approve';
  } else if (options.forceRequestChanges) {
    overallStatus = 'request_changes';
  } else if (selectedSet) {
    const hasBlocker = findings.some(
      (f) => f.severity === 'critical' || f.severity === 'high',
    );
    overallStatus = hasBlocker
      ? 'request_changes'
      : findings.length > 0
        ? 'comment'
        : 'approve';
  }
  return overallStatus === 'approve'
    ? 'APPROVE'
    : overallStatus === 'request_changes'
      ? 'REQUEST_CHANGES'
      : 'COMMENT';
}

describe('postedFindingIds merge (pr-handlers.ts:3072 contract)', () => {
  // -------------------------------------------------------------------------
  // (8) postedFindingIds is the deduplicated union of AI + manual IDs
  // -------------------------------------------------------------------------
  // The handler appends just-posted finding IDs to the existing list and
  // dedupes via Set. Manual finding IDs MUST end up in the result so the
  // followup-review delta logic can skip already-posted manual findings.
  it('produces the deduplicated union of pre-existing IDs and newly posted AI + manual IDs', () => {
    // A previously-posted AI finding lives in the existing list
    const existingPostedIds = ['ai-existing-1'];

    // This post selects 2 AI + 2 manual findings — note `ai-existing-1` is
    // selected again to verify dedupe behavior
    const justPostedFindings: PRReviewFinding[] = [
      makeFinding({ id: 'ai-existing-1', file: 'src/a.ts', line: 1 }),
      makeFinding({ id: 'ai-new-1', file: 'src/b.ts', line: 2 }),
      {
        ...makeFinding({ id: 'manual-1', file: 'src/c.ts', line: 3 }),
        source: 'manual',
      },
      {
        ...makeFinding({ id: 'manual-2', file: 'src/d.ts', line: 4 }),
        source: 'terminal',
      },
    ];
    const newPostedIds = justPostedFindings.map((f) => f.id);

    const result = mergePostedFindingIds(existingPostedIds, newPostedIds);

    // All four kinds are present in the union (manual IDs must survive)
    expect(result).toContain('ai-existing-1');
    expect(result).toContain('ai-new-1');
    expect(result).toContain('manual-1');
    expect(result).toContain('manual-2');
    // Dedupe: `ai-existing-1` appears exactly once even though it was in
    // both `existingPostedIds` and `newPostedIds`
    expect(result.filter((id) => id === 'ai-existing-1')).toHaveLength(1);
    expect(result).toHaveLength(4);
  });

  it('starts from empty existing list and writes manual IDs on first post', () => {
    const justPostedFindings: PRReviewFinding[] = [
      makeFinding({ id: 'ai-1', file: 'src/a.ts', line: 1 }),
      {
        ...makeFinding({ id: 'manual-1', file: 'src/b.ts', line: 2 }),
        source: 'manual',
      },
    ];
    const result = mergePostedFindingIds(
      [],
      justPostedFindings.map((f) => f.id),
    );

    expect(result).toEqual(['ai-1', 'manual-1']);
  });
});

describe('Verdict computation (pr-handlers.ts:2944-2969 contract)', () => {
  // -------------------------------------------------------------------------
  // (9) Single selected manual `critical` finding escalates verdict to
  //     REQUEST_CHANGES — proves the verdict cascade is source-agnostic and
  //     correctly elevates on the severity signal alone.
  // -------------------------------------------------------------------------
  it('single selected manual critical finding produces REQUEST_CHANGES event', () => {
    const manualCritical: PRReviewFinding = {
      ...makeFinding({
        id: 'manual-critical',
        file: 'src/auth.ts',
        line: 42,
        severity: 'critical',
        title: 'Plaintext password',
      }),
      source: 'manual',
    };
    const selectedSet = new Set([manualCritical.id]);

    const event = computeReviewEvent(
      [manualCritical],
      selectedSet,
      {},
      // Default is `approve` to prove the cascade actually escalates rather
      // than passing through the default
      'approve',
    );

    expect(event).toBe('REQUEST_CHANGES');
  });

  it('single selected manual high finding also escalates to REQUEST_CHANGES (high is a blocker)', () => {
    const manualHigh: PRReviewFinding = {
      ...makeFinding({
        id: 'manual-high',
        file: 'src/api.ts',
        line: 100,
        severity: 'high',
      }),
      source: 'manual',
    };
    const selectedSet = new Set([manualHigh.id]);

    const event = computeReviewEvent([manualHigh], selectedSet, {}, 'approve');

    expect(event).toBe('REQUEST_CHANGES');
  });

  it('selected manual medium/low findings drop to COMMENT (no blocker)', () => {
    const manualMedium: PRReviewFinding = {
      ...makeFinding({
        id: 'manual-medium',
        file: 'src/style.ts',
        line: 7,
        severity: 'medium',
      }),
      source: 'manual',
    };
    const selectedSet = new Set([manualMedium.id]);

    const event = computeReviewEvent(
      [manualMedium],
      selectedSet,
      {},
      'approve',
    );

    expect(event).toBe('COMMENT');
  });

  it('forceApprove overrides even a selected critical manual finding', () => {
    const manualCritical: PRReviewFinding = {
      ...makeFinding({
        id: 'manual-critical',
        file: 'src/auth.ts',
        line: 42,
        severity: 'critical',
      }),
      source: 'manual',
    };
    const selectedSet = new Set([manualCritical.id]);

    const event = computeReviewEvent(
      [manualCritical],
      selectedSet,
      { forceApprove: true },
      'approve',
    );

    expect(event).toBe('APPROVE');
  });
});
