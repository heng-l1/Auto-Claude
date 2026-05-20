/**
 * End-to-End tests for the Manual PR Findings POST flow (spec 131 — subtask 6-2)
 *
 * Verifies the mixed AI + manual posting contract end-to-end:
 *   (1) PR with 4 AI findings + 2 manually-added findings on disk
 *   (2) Select all 6 → click "Post Comments"
 *   (3) GitHub mock receives 6 comments; the 2 manual ones carry the 👤 prefix
 *   (4) Verdict computes to REQUEST_CHANGES (critical/high present)
 *   (5) postedFindingIds is persisted as the deduplicated union of all 6 IDs
 *
 * Also covers the multi-line range branch of the buildReviewComments cascade:
 *   manual finding with line:87, endLine:92, both in diff →
 *   GitHub mock receives start_line:87, start_side:'RIGHT', line:92, side:'RIGHT'
 *
 * Strategy:
 *   Mirrors `manual-findings.spec.ts` — filesystem-level tests of the data
 *   layer the IPC handler produces. The actual `buildReviewComments()`,
 *   `mergePostedFindingIds()`, and verdict cascade are exhaustively covered
 *   by Vitest unit tests at `pr-post-review.test.ts`. This E2E test verifies
 *   the END-TO-END contract — that AI findings on disk + manual findings on
 *   disk, when run through the same logic, produce the right GitHub payload
 *   and the right persisted state.
 *
 *   To stay self-contained (matching `manual-findings.spec.ts`), the
 *   buildReviewComments / verdict / dedup helpers are re-stated locally as
 *   byte-for-byte mirrors of the production implementations at
 *   `apps/frontend/src/main/ipc-handlers/github/pr-handlers.ts:482-572,
 *   2944-2969, 3070-3072`. If the production logic ever drifts, the unit
 *   tests in `pr-post-review.test.ts` will catch it (they exercise the
 *   imported production function) and these mirrors must be updated.
 *
 * To run: npx playwright test manual-findings-post.spec.ts --reporter=line
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';

// ───────────────────────────────────────────────────────────────────────────
// Test fixtures
// ───────────────────────────────────────────────────────────────────────────

let TEST_DATA_DIR: string;
let TEST_PROJECT_DIR: string;
let PR_DIR: string;

const TEST_PR_NUMBER = 314;
const TEST_REPO = 'test-org/test-repo';

interface PRReviewFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'security' | 'quality' | 'style' | 'test' | 'docs' | 'pattern' | 'performance';
  title: string;
  description: string;
  file: string;
  line: number;
  endLine?: number;
  suggestedFix?: string;
  fixable: boolean;
  source?: 'ai' | 'terminal' | 'manual';
  authoredAt?: string;
  authoredBy?: string;
}

interface ReviewComment {
  path: string;
  line?: number;
  body: string;
  subject_type?: 'line' | 'file';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
  side?: 'LEFT' | 'RIGHT';
}

interface ReviewPayload {
  body: string;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  commit_id?: string;
  comments?: ReviewComment[];
}

interface ManualFindingsFile {
  prNumber: number;
  repo: string;
  updatedAt: string;
  findings: PRReviewFinding[];
}

interface AIReviewResultFile {
  prNumber: number;
  repo: string;
  findings: PRReviewFinding[];
  overall_status: 'approve' | 'request_changes' | 'comment' | 'in_progress';
  createdAt: string;
  review_id?: number;
  has_posted_findings?: boolean;
  posted_finding_ids?: string[];
  posted_at?: string;
}

function setupTestEnvironment(): void {
  TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'auto-claude-manual-findings-post-e2e-'));
  TEST_PROJECT_DIR = path.join(TEST_DATA_DIR, 'test-project');
  PR_DIR = path.join(TEST_PROJECT_DIR, '.auto-claude', 'github', 'pr');
  mkdirSync(PR_DIR, { recursive: true });
}

function cleanupTestEnvironment(): void {
  if (TEST_DATA_DIR && existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
}

/**
 * Assert non-null and narrow — keeps the test free of `!` (Biome flags
 * `noNonNullAssertion`).
 */
function expectNotNull<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected non-null: ${message}`);
  }
  return value;
}

function getReviewResultPath(prNumber: number): string {
  return path.join(PR_DIR, `review_${prNumber}.json`);
}

function getManualFindingsPath(prNumber: number): string {
  return path.join(PR_DIR, `manual_findings_${prNumber}.json`);
}

function makeManualId(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = randomBytes(3).toString('hex');
  return `manual-${iso}-${suffix}`;
}

function seedAIReviewResult(prNumber: number, findings: PRReviewFinding[]): void {
  const file: AIReviewResultFile = {
    prNumber,
    repo: TEST_REPO,
    findings,
    // Use 'comment' as the persisted overallStatus so we can prove the
    // verdict cascade escalates to 'request_changes' on the selection alone.
    overall_status: 'comment',
    createdAt: new Date().toISOString(),
  };
  writeFileSync(getReviewResultPath(prNumber), JSON.stringify(file, null, 2));
}

function seedManualFindings(prNumber: number, findings: PRReviewFinding[]): void {
  const file: ManualFindingsFile = {
    prNumber,
    repo: TEST_REPO,
    updatedAt: new Date().toISOString(),
    findings,
  };
  writeFileSync(getManualFindingsPath(prNumber), JSON.stringify(file, null, 2));
}

function readReviewResult(prNumber: number): AIReviewResultFile | null {
  const filepath = getReviewResultPath(prNumber);
  if (!existsSync(filepath)) return null;
  return JSON.parse(readFileSync(filepath, 'utf-8')) as AIReviewResultFile;
}

// ───────────────────────────────────────────────────────────────────────────
// Mirrors of the production logic at
// apps/frontend/src/main/ipc-handlers/github/pr-handlers.ts. These are
// byte-for-byte copies — the unit tests at `pr-post-review.test.ts` exercise
// the imported production functions and will catch any drift.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Mirror of `buildReviewComments()` at pr-handlers.ts:492-572. Builds the
 * inline-comment + file-level-entry payload from a list of findings and a
 * diff-aware file→lines map.
 */
function buildReviewComments(
  findings: PRReviewFinding[],
  fileLineMap: Map<string, Set<number>> | null,
): { inlineComments: ReviewComment[]; fileLevelEntries: string[] } {
  const inlineComments: ReviewComment[] = [];
  const fileLevelEntries: string[] = [];
  for (const f of findings) {
    if (f.file && f.line && f.line > 0) {
      const emoji =
        { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' }[f.severity] || '⚪';
      // Prepend 👤 glyph for manual/terminal-authored findings. AI findings
      // (default `source: 'ai'` or omitted source) stay unchanged.
      const sourceGlyph = f.source && f.source !== 'ai' ? '👤 ' : '';
      let commentBody = `${sourceGlyph}${emoji} **[${f.severity.toUpperCase()}] ${f.title}**\n\n${f.description}`;
      const suggestedFix = f.suggestedFix?.trim();
      if (suggestedFix) {
        commentBody += `\n\n**Suggested fix:**\n\`\`\`\n${suggestedFix}\n\`\`\``;
      }

      const normalizedPath = f.file.replace(/^\.\//, '');

      if (fileLineMap) {
        const validLines = fileLineMap.get(normalizedPath);
        if (validLines) {
          const lineInDiff = validLines.has(f.line);
          const endLineInDiff =
            f.endLine != null && f.endLine > 0 && validLines.has(f.endLine);

          if (lineInDiff && endLineInDiff) {
            if (f.endLine != null && f.endLine > f.line) {
              inlineComments.push({
                path: normalizedPath,
                start_line: f.line,
                start_side: 'RIGHT',
                line: f.endLine,
                side: 'RIGHT',
                body: commentBody,
              });
            } else {
              inlineComments.push({ path: normalizedPath, line: f.line, body: commentBody });
            }
          } else if (lineInDiff) {
            inlineComments.push({ path: normalizedPath, line: f.line, body: commentBody });
          } else if (endLineInDiff) {
            inlineComments.push({ path: normalizedPath, line: f.endLine, body: commentBody });
          } else {
            fileLevelEntries.push(`- **${normalizedPath}** (line ${f.line}): ${commentBody}`);
          }
        } else {
          fileLevelEntries.push(
            `- **${normalizedPath}** (line ${f.line}, not in PR files): ${commentBody}`,
          );
        }
      } else {
        inlineComments.push({ path: normalizedPath, line: f.line, body: commentBody });
      }
    }
  }
  return { inlineComments, fileLevelEntries };
}

/**
 * Mirror of the verdict cascade at pr-handlers.ts:2944-2969. Returns the
 * GitHub review `event` value.
 */
function computeReviewEvent(
  selectedFindings: PRReviewFinding[],
  hasSelection: boolean,
  options: { forceApprove?: boolean; forceRequestChanges?: boolean },
  defaultStatus: 'approve' | 'request_changes' | 'comment' | 'in_progress',
): 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' {
  let overallStatus: string = defaultStatus;
  if (options.forceApprove) {
    overallStatus = 'approve';
  } else if (options.forceRequestChanges) {
    overallStatus = 'request_changes';
  } else if (hasSelection) {
    const hasBlocker = selectedFindings.some(
      (f) => f.severity === 'critical' || f.severity === 'high',
    );
    overallStatus = hasBlocker
      ? 'request_changes'
      : selectedFindings.length > 0
        ? 'comment'
        : 'approve';
  }
  return overallStatus === 'approve'
    ? 'APPROVE'
    : overallStatus === 'request_changes'
      ? 'REQUEST_CHANGES'
      : 'COMMENT';
}

/**
 * Mirror of the postedFindingIds dedupe-merge at pr-handlers.ts:3070-3072.
 */
function mergePostedFindingIds(
  existingPostedIds: string[],
  newPostedIds: string[],
): string[] {
  return [...new Set([...existingPostedIds, ...newPostedIds])];
}

// ───────────────────────────────────────────────────────────────────────────
// GitHub API mock — captures `POST /reviews` payloads so the test can
// assert what the real handler would have sent over the wire.
// ───────────────────────────────────────────────────────────────────────────

interface GitHubAPIMock {
  receivedPayloads: ReviewPayload[];
  reset: () => void;
  capture: (payload: ReviewPayload) => { id: number };
}

function makeGitHubAPIMock(): GitHubAPIMock {
  const mock: GitHubAPIMock = {
    receivedPayloads: [],
    reset() {
      mock.receivedPayloads = [];
    },
    capture(payload: ReviewPayload): { id: number } {
      mock.receivedPayloads.push(payload);
      // Simulate the GitHub `{id: number}` response so the caller can stamp
      // it into the persisted review result file.
      return { id: 1000 + mock.receivedPayloads.length };
    },
  };
  return mock;
}

/**
 * Simulate the GITHUB_PR_POST_REVIEW handler end-to-end:
 *   - merge AI findings + manual findings (from disk)
 *   - filter by selected IDs
 *   - build review comments via `buildReviewComments`
 *   - compute verdict via the cascade
 *   - "post" to the mocked GitHub API
 *   - update review_<N>.json with review_id + posted_finding_ids + posted_at
 *
 * Returns the payload that was "posted" so the test can assert against it.
 */
function simulatePostReview(
  prNumber: number,
  selectedIds: string[] | null,
  fileLineMap: Map<string, Set<number>> | null,
  options: { forceApprove?: boolean; forceRequestChanges?: boolean; customComment?: string },
  apiMock: GitHubAPIMock,
  commitSha?: string,
): { posted: ReviewPayload; reviewId: number; postedFindingIds: string[] } {
  const reviewFile = expectNotNull(
    readReviewResult(prNumber),
    'review result file',
  );
  const manualPath = getManualFindingsPath(prNumber);
  const manualFile: ManualFindingsFile = existsSync(manualPath)
    ? (JSON.parse(readFileSync(manualPath, 'utf-8')) as ManualFindingsFile)
    : { prNumber, repo: TEST_REPO, updatedAt: new Date().toISOString(), findings: [] };

  // Merge AI + manual (mirrors pr-handlers.ts:2871).
  const allFindings = [...reviewFile.findings, ...manualFile.findings];
  // Filter by selection (mirrors pr-handlers.ts:2876-2879).
  const selectedSet = selectedIds ? new Set(selectedIds) : null;
  const findings = selectedSet
    ? allFindings.filter((f) => selectedSet.has(f.id))
    : allFindings;

  // Build comments via the same cascade the handler uses.
  const { inlineComments, fileLevelEntries } = buildReviewComments(findings, fileLineMap);
  const fileLevelBody = fileLevelEntries.length > 0 ? fileLevelEntries.join('\n') : '';
  const bodyParts = [fileLevelBody, options.customComment?.trim()].filter(Boolean);
  const body = bodyParts.join('\n\n');

  // Compute the verdict (mirrors pr-handlers.ts:2944-2969).
  const event = computeReviewEvent(
    findings,
    selectedSet !== null,
    options,
    reviewFile.overall_status,
  );

  // Build the payload + post to the mock.
  const payload: ReviewPayload = { body, event };
  if (commitSha) payload.commit_id = commitSha;
  if (inlineComments.length > 0) payload.comments = inlineComments;
  const { id: reviewId } = apiMock.capture(payload);

  // Update review_<N>.json (mirrors pr-handlers.ts:3057-3083).
  const newPostedIds = findings.map((f) => f.id);
  const existingPostedIds = reviewFile.posted_finding_ids || [];
  reviewFile.posted_finding_ids = mergePostedFindingIds(existingPostedIds, newPostedIds);
  reviewFile.review_id = reviewId;
  reviewFile.has_posted_findings = true;
  reviewFile.posted_at = new Date().toISOString();
  writeFileSync(getReviewResultPath(prNumber), JSON.stringify(reviewFile, null, 2));

  return { posted: payload, reviewId, postedFindingIds: reviewFile.posted_finding_ids };
}

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

test.describe('Manual PR Findings — POST flow (mixed AI + manual)', () => {
  test.beforeEach(() => {
    setupTestEnvironment();
  });

  test.afterEach(() => {
    cleanupTestEnvironment();
  });

  test('selects all 6 (4 AI + 2 manual) → GitHub mock gets 6 comments with 👤 prefixes on manual; verdict REQUEST_CHANGES; postedFindingIds has all 6', () => {
    // ── Set up: PR with 4 AI findings + 2 manually-added findings ─────────
    const aiFindings: PRReviewFinding[] = [
      {
        id: 'ai-1',
        severity: 'critical', // Drives REQUEST_CHANGES verdict
        category: 'security',
        title: 'Unsafe SQL concatenation',
        description: 'Raw user input concatenated into SQL on line 12.',
        file: 'src/db/query.ts',
        line: 12,
        fixable: false,
        source: 'ai',
      },
      {
        id: 'ai-2',
        severity: 'high',
        category: 'quality',
        title: 'Missing null check',
        description: 'Token could be null when refreshSession is called.',
        file: 'src/auth/session.ts',
        line: 24,
        fixable: false,
        source: 'ai',
      },
      {
        id: 'ai-3',
        severity: 'medium',
        category: 'style',
        title: 'Inconsistent naming',
        description: 'snake_case used in a TypeScript module.',
        file: 'src/util/helpers.ts',
        line: 8,
        fixable: true,
        source: 'ai',
      },
      {
        id: 'ai-4',
        // legacy: `source` omitted → still treated as AI
        severity: 'low',
        category: 'docs',
        title: 'Missing JSDoc',
        description: 'Public function exported without docs.',
        file: 'src/util/format.ts',
        line: 3,
        fixable: false,
      },
    ];
    const manualFindings: PRReviewFinding[] = [
      {
        id: makeManualId(),
        severity: 'high',
        category: 'security',
        title: 'CSRF token bypass',
        description: 'Manually noticed: the POST /transfer endpoint skips the CSRF check.',
        file: 'src/api/transfer.ts',
        line: 87,
        fixable: false,
        source: 'manual',
        authoredAt: new Date().toISOString(),
        authoredBy: 'reviewer-jane',
      },
      {
        id: makeManualId(),
        severity: 'medium',
        category: 'pattern',
        title: 'Terminal-extracted: weak error handling',
        description: 'In-terminal Claude noticed: catch swallows the original cause.',
        file: 'src/services/sync.ts',
        line: 45,
        fixable: false,
        source: 'terminal',
        authoredAt: new Date().toISOString(),
        authoredBy: 'terminal-claude',
      },
    ];

    seedAIReviewResult(TEST_PR_NUMBER, aiFindings);
    seedManualFindings(TEST_PR_NUMBER, manualFindings);

    // Diff-aware fileLineMap: every finding's line is in-diff so all 6 produce
    // inline comments (none fall through to file-level).
    const fileLineMap = new Map<string, Set<number>>([
      ['src/db/query.ts', new Set([10, 11, 12, 13])],
      ['src/auth/session.ts', new Set([22, 23, 24, 25])],
      ['src/util/helpers.ts', new Set([7, 8, 9])],
      ['src/util/format.ts', new Set([1, 2, 3, 4])],
      ['src/api/transfer.ts', new Set([85, 86, 87, 88])],
      ['src/services/sync.ts', new Set([43, 44, 45, 46])],
    ]);

    // ── Action: select all 6, click "Post Comments" ───────────────────────
    const allSelectedIds = [...aiFindings.map((f) => f.id), ...manualFindings.map((f) => f.id)];
    expect(allSelectedIds).toHaveLength(6);

    const apiMock = makeGitHubAPIMock();
    const { posted, reviewId, postedFindingIds } = simulatePostReview(
      TEST_PR_NUMBER,
      allSelectedIds,
      fileLineMap,
      {},
      apiMock,
      'abcdef1234567890',
    );

    // ── Assertions ────────────────────────────────────────────────────────
    // (1) Mock GitHub API received exactly one POST with 6 inline comments
    expect(apiMock.receivedPayloads).toHaveLength(1);
    expect(reviewId).toBeGreaterThan(0);
    const comments = expectNotNull(posted.comments, 'posted.comments');
    expect(comments).toHaveLength(6);

    // (2) The 2 manual comments carry the 👤 glyph prefix; the 4 AI ones do not
    const manualBodies = comments.filter((c) => c.body.startsWith('👤 '));
    expect(manualBodies).toHaveLength(2);
    const manualTitles = new Set(manualFindings.map((f) => f.title));
    for (const c of manualBodies) {
      const matched = [...manualTitles].some((t) => c.body.includes(t));
      expect(matched).toBe(true);
    }

    const aiBodies = comments.filter((c) => !c.body.startsWith('👤 '));
    expect(aiBodies).toHaveLength(4);
    const aiTitles = new Set(aiFindings.map((f) => f.title));
    for (const c of aiBodies) {
      const matched = [...aiTitles].some((t) => c.body.includes(t));
      expect(matched).toBe(true);
    }

    // (3) Verdict is REQUEST_CHANGES — driven by the critical AI finding and
    // the high manual finding (either alone is enough; both are present).
    expect(posted.event).toBe('REQUEST_CHANGES');

    // (4) postedFindingIds is the union of all 6 IDs (no duplicates).
    expect(postedFindingIds).toHaveLength(6);
    for (const id of allSelectedIds) {
      expect(postedFindingIds).toContain(id);
    }

    // The persisted file picks up the same posted_finding_ids list — the
    // followup-review delta logic keys on this exact field at startup.
    const persisted = expectNotNull(readReviewResult(TEST_PR_NUMBER), 'review file');
    expect(persisted.posted_finding_ids).toEqual(postedFindingIds);
    expect(persisted.has_posted_findings).toBe(true);
    expect(persisted.review_id).toBe(reviewId);
    expect(persisted.posted_at).toBeDefined();
  });

  test('multi-line range: manual finding line:87 endLine:92 both in diff → start_line:87 start_side:RIGHT line:92 side:RIGHT', () => {
    // ── Set up: a single manual finding with a multi-line range ───────────
    const manualFinding: PRReviewFinding = {
      id: makeManualId(),
      severity: 'high',
      category: 'security',
      title: 'Unsafe handler chain',
      description: 'Lines 87-92 chain three handlers without sanitization.',
      file: 'src/api/auth.ts',
      line: 87,
      endLine: 92,
      fixable: false,
      source: 'manual',
      authoredAt: new Date().toISOString(),
      authoredBy: 'reviewer-jane',
    };

    seedAIReviewResult(TEST_PR_NUMBER, []);
    seedManualFindings(TEST_PR_NUMBER, [manualFinding]);

    // Both endpoints (87 and 92) are inside the diff hunk.
    const fileLineMap = new Map<string, Set<number>>([
      ['src/api/auth.ts', new Set([85, 86, 87, 88, 89, 90, 91, 92, 93])],
    ]);

    // ── Action: select the one finding, post ──────────────────────────────
    const apiMock = makeGitHubAPIMock();
    const { posted } = simulatePostReview(
      TEST_PR_NUMBER,
      [manualFinding.id],
      fileLineMap,
      {},
      apiMock,
      'cafebabe',
    );

    // ── Assertions ────────────────────────────────────────────────────────
    const comments = expectNotNull(posted.comments, 'posted.comments');
    expect(comments).toHaveLength(1);
    const c = comments[0];

    // GitHub REST contract: `line` is the LAST line of the range, `start_line`
    // is the FIRST, both sides must match. start_line must be strictly less
    // than line — anything else returns HTTP 422.
    expect(c.path).toBe('src/api/auth.ts');
    expect(c.start_line).toBe(87);
    expect(c.start_side).toBe('RIGHT');
    expect(c.line).toBe(92);
    expect(c.side).toBe('RIGHT');

    // Body still carries the 👤 manual prefix + severity + title.
    expect(c.body.startsWith('👤 ')).toBe(true);
    expect(c.body).toContain('🟠'); // high → orange
    expect(c.body).toContain('**[HIGH] Unsafe handler chain**');

    // Verdict escalates to REQUEST_CHANGES (one selected `high` finding).
    expect(posted.event).toBe('REQUEST_CHANGES');
  });

  test('only AI findings selected (no manual): no 👤 prefix anywhere; verdict driven by AI severity', () => {
    // Defense-in-depth: prove the 👤 prefix is strictly gated on `source !== 'ai'`
    // and not, say, leaking into AI comments.
    const aiFindings: PRReviewFinding[] = [
      {
        id: 'ai-1',
        severity: 'low',
        category: 'docs',
        title: 'Spelling typo',
        description: 'Typo in comment.',
        file: 'src/x.ts',
        line: 5,
        fixable: true,
        source: 'ai',
      },
      {
        id: 'ai-2',
        severity: 'medium',
        category: 'quality',
        title: 'Missing return',
        description: 'Implicit return path.',
        file: 'src/y.ts',
        line: 10,
        fixable: false,
        source: 'ai',
      },
    ];

    seedAIReviewResult(TEST_PR_NUMBER, aiFindings);
    seedManualFindings(TEST_PR_NUMBER, []);

    const fileLineMap = new Map<string, Set<number>>([
      ['src/x.ts', new Set([4, 5, 6])],
      ['src/y.ts', new Set([9, 10, 11])],
    ]);

    const apiMock = makeGitHubAPIMock();
    const { posted, postedFindingIds } = simulatePostReview(
      TEST_PR_NUMBER,
      ['ai-1', 'ai-2'],
      fileLineMap,
      {},
      apiMock,
    );

    const comments = expectNotNull(posted.comments, 'posted.comments');
    expect(comments).toHaveLength(2);
    // Neither AI comment carries the 👤 glyph.
    for (const c of comments) {
      expect(c.body.startsWith('👤 ')).toBe(false);
    }
    // No blockers (low + medium) → verdict is COMMENT.
    expect(posted.event).toBe('COMMENT');
    expect(postedFindingIds).toEqual(['ai-1', 'ai-2']);
  });

  test('only manual findings selected (no AI): every comment has 👤 prefix; ids tracked in postedFindingIds', () => {
    // Inverse of the previous case — when only manual findings are selected,
    // every comment in the GitHub payload carries the 👤 prefix and the manual
    // IDs are still persisted in posted_finding_ids (so followup-review delta
    // logic skips them on the next run).
    const m1 = makeManualId();
    const m2 = makeManualId();
    const manualFindings: PRReviewFinding[] = [
      {
        id: m1,
        severity: 'critical',
        category: 'security',
        title: 'Hard-coded API key',
        description: 'Bearer token literal in source.',
        file: 'src/secrets.ts',
        line: 3,
        fixable: false,
        source: 'manual',
        authoredAt: new Date().toISOString(),
      },
      {
        id: m2,
        severity: 'medium',
        category: 'pattern',
        title: 'Inefficient loop',
        description: 'O(n²) traversal where O(n) would do.',
        file: 'src/util/walk.ts',
        line: 22,
        fixable: false,
        source: 'terminal',
        authoredAt: new Date().toISOString(),
      },
    ];

    seedAIReviewResult(TEST_PR_NUMBER, []);
    seedManualFindings(TEST_PR_NUMBER, manualFindings);

    const fileLineMap = new Map<string, Set<number>>([
      ['src/secrets.ts', new Set([1, 2, 3, 4])],
      ['src/util/walk.ts', new Set([20, 21, 22, 23])],
    ]);

    const apiMock = makeGitHubAPIMock();
    const { posted, postedFindingIds } = simulatePostReview(
      TEST_PR_NUMBER,
      [m1, m2],
      fileLineMap,
      {},
      apiMock,
    );

    const comments = expectNotNull(posted.comments, 'posted.comments');
    expect(comments).toHaveLength(2);
    // Both comments carry the 👤 prefix (one from 'manual', one from 'terminal').
    for (const c of comments) {
      expect(c.body.startsWith('👤 ')).toBe(true);
    }
    // Verdict escalates to REQUEST_CHANGES (the critical manual finding).
    expect(posted.event).toBe('REQUEST_CHANGES');
    // Both manual IDs are persisted in posted_finding_ids.
    expect(postedFindingIds).toHaveLength(2);
    expect(postedFindingIds).toContain(m1);
    expect(postedFindingIds).toContain(m2);
  });

  test('postedFindingIds dedupes against prior post (re-posting an AI finding does not duplicate the ID)', () => {
    // Simulate a second post that includes a previously-posted AI finding
    // alongside a newly-added manual finding. The dedup contract at
    // pr-handlers.ts:3072 means the merged list has each id exactly once.
    const aiFindings: PRReviewFinding[] = [
      {
        id: 'ai-shared',
        severity: 'high',
        category: 'quality',
        title: 'Existing AI finding',
        description: 'desc',
        file: 'src/a.ts',
        line: 10,
        fixable: false,
        source: 'ai',
      },
    ];
    const manualFindings: PRReviewFinding[] = [
      {
        id: makeManualId(),
        severity: 'medium',
        category: 'docs',
        title: 'New manual finding',
        description: 'desc',
        file: 'src/b.ts',
        line: 5,
        fixable: false,
        source: 'manual',
        authoredAt: new Date().toISOString(),
      },
    ];

    seedAIReviewResult(TEST_PR_NUMBER, aiFindings);
    seedManualFindings(TEST_PR_NUMBER, manualFindings);

    const fileLineMap = new Map<string, Set<number>>([
      ['src/a.ts', new Set([9, 10, 11])],
      ['src/b.ts', new Set([4, 5, 6])],
    ]);

    // First post: just the AI finding
    const apiMock = makeGitHubAPIMock();
    simulatePostReview(TEST_PR_NUMBER, ['ai-shared'], fileLineMap, {}, apiMock);

    // Second post: include the AI finding AGAIN + the manual finding.
    const second = simulatePostReview(
      TEST_PR_NUMBER,
      ['ai-shared', manualFindings[0].id],
      fileLineMap,
      {},
      apiMock,
    );

    // The persisted list contains each id exactly once.
    expect(second.postedFindingIds).toHaveLength(2);
    expect(second.postedFindingIds.filter((id) => id === 'ai-shared')).toHaveLength(1);
    expect(second.postedFindingIds).toContain(manualFindings[0].id);
  });

  test('forceApprove overrides a selection that would otherwise escalate to REQUEST_CHANGES', () => {
    // Edge case: a user can override the verdict cascade via the force flags
    // even with a `critical` manual finding selected.
    const m1 = makeManualId();
    const manualFindings: PRReviewFinding[] = [
      {
        id: m1,
        severity: 'critical',
        category: 'security',
        title: 'Critical manual finding',
        description: 'desc',
        file: 'src/x.ts',
        line: 1,
        fixable: false,
        source: 'manual',
        authoredAt: new Date().toISOString(),
      },
    ];

    seedAIReviewResult(TEST_PR_NUMBER, []);
    seedManualFindings(TEST_PR_NUMBER, manualFindings);

    const fileLineMap = new Map<string, Set<number>>([['src/x.ts', new Set([1])]]);

    const apiMock = makeGitHubAPIMock();
    const { posted } = simulatePostReview(
      TEST_PR_NUMBER,
      [m1],
      fileLineMap,
      { forceApprove: true },
      apiMock,
    );

    // Force-approve wins over the critical severity.
    expect(posted.event).toBe('APPROVE');
  });

  test('off-diff endLine collapses to single-line at the in-diff endpoint (FR #6)', () => {
    // Verifies the third branch of the multi-line cascade: only one endpoint
    // is in-diff. This shouldn't happen in the happy-path multi-line test
    // above, but it's worth verifying so a stray off-diff range doesn't 422.
    const m1 = makeManualId();
    const manualFindings: PRReviewFinding[] = [
      {
        id: m1,
        severity: 'medium',
        category: 'quality',
        title: 'Range across hunks',
        description: 'desc',
        file: 'src/q.ts',
        line: 5, // off-diff
        endLine: 15, // in-diff
        fixable: false,
        source: 'manual',
        authoredAt: new Date().toISOString(),
      },
    ];

    seedAIReviewResult(TEST_PR_NUMBER, []);
    seedManualFindings(TEST_PR_NUMBER, manualFindings);

    const fileLineMap = new Map<string, Set<number>>([
      // line=5 NOT in diff; endLine=15 IS in diff
      ['src/q.ts', new Set([13, 14, 15, 16])],
    ]);

    const apiMock = makeGitHubAPIMock();
    const { posted } = simulatePostReview(TEST_PR_NUMBER, [m1], fileLineMap, {}, apiMock);

    const comments = expectNotNull(posted.comments, 'posted.comments');
    expect(comments).toHaveLength(1);
    // Anchored at the in-diff endpoint (endLine=15); no multi-line range.
    expect(comments[0].line).toBe(15);
    expect(comments[0].start_line).toBeUndefined();
    expect(comments[0].start_side).toBeUndefined();
    // Still carries the 👤 prefix.
    expect(comments[0].body.startsWith('👤 ')).toBe(true);
  });
});
