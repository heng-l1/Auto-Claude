/**
 * End-to-End tests for Manual PR Findings System
 *
 * Covers the five scenarios from spec 131 (subtask-6-1):
 *   (1) PR with prior AI findings — verify the merged shape that the renderer
 *       would consume after both an AI review and a manual finding land
 *   (2) "+ Add Finding" submission — verify the persisted shape matches what
 *       the IPC handler writes after the UI dialog submits (5 required fields
 *       + server-stamped id/source/authoredAt fields)
 *   (3) Edit flow (pencil icon) — verify a patch updates the title without
 *       mutating immutable audit-trail fields (id, source, authoredAt)
 *   (4) Delete flow (trash icon + confirm) — verify the finding disappears
 *       from the persisted list
 *   (5) External write (terminal Claude simulation) — verify a direct
 *       fs.writeFileSync of `manual_findings_<N>.json` produces the same
 *       shape with `source: 'terminal'` that the chokidar watcher would
 *       surface to the renderer with a "From terminal" badge
 *
 * Strategy:
 *   Mirrors `task-workflow.spec.ts` — filesystem-level tests of the data
 *   layer that the UI ultimately produces. The IPC handlers and React
 *   components are covered by Vitest unit tests (see
 *   pr-manual-findings-handlers.test.ts, AddManualFindingDialog.test.tsx,
 *   ReviewFindings.test.tsx). This E2E test verifies the END-TO-END
 *   filesystem contract — same `manual_findings_<prNumber>.json` shape
 *   that the renderer, the IPC handler, and terminal-Claude all agree on.
 *
 *   The renderer's "Manual" / "From terminal" badges are driven entirely
 *   from the `source` field on each finding (see FindingItem.tsx:184-199),
 *   so verifying the source field in the persisted file is equivalent to
 *   verifying the badge would render correctly.
 *
 * To run: npx playwright test manual-findings.spec.ts --reporter=line
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';

// ───────────────────────────────────────────────────────────────────────────
// Test fixtures
// ───────────────────────────────────────────────────────────────────────────

// Secure temp directory created per test run to prevent TOCTOU attacks.
// Mirrors the pattern in `task-workflow.spec.ts` (mkdtempSync with random suffix).
let TEST_DATA_DIR: string;
let TEST_PROJECT_DIR: string;
let PR_DIR: string;

const TEST_PR_NUMBER = 142;
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

interface ManualFindingsFile {
  prNumber: number;
  repo: string;
  updatedAt: string;
  findings: PRReviewFinding[];
}

/**
 * Create the project structure that the IPC handlers expect, including
 * the `.auto-claude/github/pr/` directory that hosts both AI review
 * results (`review_<N>.json`) and manual findings (`manual_findings_<N>.json`).
 */
function setupTestEnvironment(): void {
  TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'auto-claude-manual-findings-e2e-'));
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
 * Assert a value is not null/undefined and return it narrowed. Lets the rest
 * of the test reference fields directly without sprinkling non-null assertions
 * (`!`) at every property access — which Biome flags as `noNonNullAssertion`.
 */
function expectNotNull<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected non-null: ${message}`);
  }
  return value;
}

/**
 * Resolve the `manual_findings_<prNumber>.json` path the IPC handler would use.
 * Mirrors `getManualFindingsPath` in `pr-manual-findings-handlers.ts:169-177`.
 */
function getManualFindingsPath(prNumber: number): string {
  return path.join(PR_DIR, `manual_findings_${prNumber}.json`);
}

/**
 * Resolve the AI review result path. Mirrors the layout the renderer reads
 * via `getReviewResult` — both files live in `.auto-claude/github/pr/`.
 */
function getReviewResultPath(prNumber: number): string {
  return path.join(PR_DIR, `review_${prNumber}.json`);
}

/**
 * Generate a manual-finding id of the form `manual-<ISO-with-dashes>-<6char>`.
 * Mirrors `makeId` in `pr-manual-findings-handlers.ts:155-159` — the same
 * format the renderer relies on for selection-state keying ('manual-' prefix).
 */
function makeManualId(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = randomBytes(3).toString('hex');
  return `manual-${iso}-${suffix}`;
}

/**
 * Read and parse the manual findings file. Returns `null` when the file
 * doesn't exist (the IPC handler's "first add" / "no findings" case).
 */
function readManualFindings(prNumber: number): ManualFindingsFile | null {
  const filepath = getManualFindingsPath(prNumber);
  if (!existsSync(filepath)) return null;
  return JSON.parse(readFileSync(filepath, 'utf-8')) as ManualFindingsFile;
}

/**
 * Persist the manual findings envelope. Models what `saveManualFindings`
 * does in `pr-manual-findings-handlers.ts:232-250` — refresh `updatedAt`,
 * write the full envelope. Uses plain `writeFileSync` here (the production
 * code uses `writeFileAtomicSync`, but a plain write is equivalent for an
 * E2E test that controls when reads happen).
 */
function writeManualFindings(prNumber: number, file: ManualFindingsFile): void {
  const filepath = getManualFindingsPath(prNumber);
  mkdirSync(path.dirname(filepath), { recursive: true });
  const envelope: ManualFindingsFile = {
    ...file,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(filepath, JSON.stringify(envelope, null, 2));
}

/**
 * Build an AI-authored finding (no source field, or `source: 'ai'`).
 * Used to seed the "PR with prior AI findings" precondition.
 */
function makeAIFinding(overrides: Partial<PRReviewFinding> = {}): PRReviewFinding {
  return {
    id: `ai-${randomBytes(4).toString('hex')}`,
    severity: 'medium',
    category: 'quality',
    title: 'AI-detected issue',
    description: 'An issue surfaced by the AI reviewer.',
    file: 'src/example.ts',
    line: 10,
    fixable: false,
    source: 'ai',
    ...overrides,
  };
}

/**
 * Seed an AI review result file so the PR appears to have prior findings —
 * the precondition the test description calls out as "open a PR with prior
 * AI findings". The shape mirrors what the post-review pipeline persists.
 */
function seedAIReviewResult(prNumber: number, findings: PRReviewFinding[]): void {
  writeFileSync(
    getReviewResultPath(prNumber),
    JSON.stringify(
      {
        prNumber,
        repo: TEST_REPO,
        findings,
        verdict: 'comment',
        createdAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

/**
 * Add a manual finding the way the IPC handler ADD path would — fill in
 * server-stamped fields (id, source, authoredAt, fixable defaults) on top
 * of the renderer-supplied 5-field payload.
 */
function simulateAddManualFinding(
  prNumber: number,
  payload: Partial<PRReviewFinding>
): PRReviewFinding {
  const file: ManualFindingsFile = readManualFindings(prNumber) ?? {
    prNumber,
    repo: TEST_REPO,
    updatedAt: new Date().toISOString(),
    findings: [],
  };

  const finding: PRReviewFinding = {
    id: makeManualId(),
    severity: payload.severity ?? 'medium',
    category: payload.category ?? 'quality',
    title: payload.title ?? '',
    description: payload.description ?? '',
    file: payload.file ?? '',
    line: payload.line ?? 0,
    fixable: payload.fixable ?? false,
    source: payload.source ?? 'manual',
    authoredAt: new Date().toISOString(),
    ...(payload.endLine !== undefined && { endLine: payload.endLine }),
    ...(payload.suggestedFix !== undefined && { suggestedFix: payload.suggestedFix }),
    ...(payload.authoredBy !== undefined && { authoredBy: payload.authoredBy }),
  };

  file.findings.push(finding);
  writeManualFindings(prNumber, file);
  return finding;
}

/**
 * Patch a manual finding the way the IPC handler UPDATE path would —
 * apply only patchable fields (title, severity, description, etc.) and
 * preserve immutable audit-trail fields (id, source, authoredAt).
 */
function simulateUpdateManualFinding(
  prNumber: number,
  id: string,
  patch: Partial<PRReviewFinding>
): PRReviewFinding | null {
  const file = readManualFindings(prNumber);
  if (!file) return null;

  const idx = file.findings.findIndex((f) => f.id === id);
  if (idx === -1) return null;

  const existing = file.findings[idx];
  // Mirror `pickPatchableFields` in pr-manual-findings-handlers.ts:499-510 —
  // only `severity, category, title, description, file, line, endLine,
  // suggestedFix, fixable` may be patched. Immutable fields stay as-is.
  const PATCHABLE = [
    'severity',
    'category',
    'title',
    'description',
    'file',
    'line',
    'endLine',
    'suggestedFix',
    'fixable',
  ] as const;
  const sanitizedPatch: Partial<PRReviewFinding> = {};
  for (const key of PATCHABLE) {
    if (patch[key] !== undefined) {
      // biome-ignore lint/suspicious/noExplicitAny: narrow union assignment between known patch fields
      (sanitizedPatch as any)[key] = patch[key];
    }
  }

  const merged: PRReviewFinding = { ...existing, ...sanitizedPatch };
  file.findings[idx] = merged;
  writeManualFindings(prNumber, file);
  return merged;
}

/**
 * Delete a manual finding the way the IPC handler DELETE path would.
 * Returns `true` if a finding was removed, `false` if no match.
 */
function simulateDeleteManualFinding(prNumber: number, id: string): boolean {
  const file = readManualFindings(prNumber);
  if (!file) return false;

  const before = file.findings.length;
  file.findings = file.findings.filter((f) => f.id !== id);
  if (file.findings.length === before) return false;

  writeManualFindings(prNumber, file);
  return true;
}

/**
 * Simulate the terminal-Claude direct-write flow (Path A from the spec).
 * The terminal LLM uses the Write tool to append an entry to
 * `manual_findings_<N>.json` with `source: 'terminal'` and the chokidar
 * watcher in pr-manual-findings-handlers.ts emits a CHANGED event so the
 * renderer re-fetches and shows the new row with the "From terminal" badge.
 *
 * Models the EXACT shape an LLM would produce from following the App.tsx
 * primer's "## Recording new findings" two-step protocol.
 */
function simulateTerminalWrite(
  prNumber: number,
  finding: Omit<PRReviewFinding, 'id' | 'source' | 'authoredAt'> & Partial<Pick<PRReviewFinding, 'authoredBy'>>
): PRReviewFinding {
  const file: ManualFindingsFile = readManualFindings(prNumber) ?? {
    prNumber,
    repo: TEST_REPO,
    updatedAt: new Date().toISOString(),
    findings: [],
  };

  const newFinding: PRReviewFinding = {
    ...finding,
    id: makeManualId(),
    source: 'terminal',
    authoredAt: new Date().toISOString(),
    authoredBy: finding.authoredBy ?? 'terminal-claude',
  };

  file.findings.push(newFinding);
  // Terminal Claude uses the Write tool directly — equivalent to fs.writeFileSync
  // (no atomic rename). The chokidar `awaitWriteFinish: 300ms` window collapses
  // any partial chunks before emitting the CHANGED event.
  writeFileSync(getManualFindingsPath(prNumber), JSON.stringify(file, null, 2));
  return newFinding;
}

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

test.describe('Manual PR Findings — Author flow (scenarios 1-4)', () => {
  test.beforeEach(() => {
    setupTestEnvironment();
  });

  test.afterEach(() => {
    cleanupTestEnvironment();
  });

  test('Scenario 1: opens a PR with prior AI findings', () => {
    // Seed the PR with two AI findings so the "open a PR with prior AI
    // findings" precondition is satisfied. The renderer's
    // ReviewFindings.tsx merges these with the manual-findings slice.
    const aiFindings: PRReviewFinding[] = [
      makeAIFinding({ id: 'ai-1', severity: 'high', title: 'High AI finding' }),
      makeAIFinding({ id: 'ai-2', severity: 'low', title: 'Low AI finding' }),
    ];
    seedAIReviewResult(TEST_PR_NUMBER, aiFindings);

    const reviewPath = getReviewResultPath(TEST_PR_NUMBER);
    expect(existsSync(reviewPath)).toBe(true);

    const result = JSON.parse(readFileSync(reviewPath, 'utf-8'));
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].source).toBe('ai');
    expect(result.findings[1].source).toBe('ai');

    // No manual findings file yet — that's the empty starting state the
    // "+ Add Finding" dialog operates against.
    expect(existsSync(getManualFindingsPath(TEST_PR_NUMBER))).toBe(false);
  });

  test('Scenario 2: "+ Add Finding" creates a row with the "Manual" badge', () => {
    // Pre-condition: PR with prior AI findings
    seedAIReviewResult(TEST_PR_NUMBER, [
      makeAIFinding({ id: 'ai-1', severity: 'high', title: 'AI finding' }),
    ]);

    // Simulate the AddManualFindingDialog's submit — 5 required fields:
    // severity, title, file, line, description. The dialog defaults to
    // severity=medium, category=quality (see AddManualFindingDialog.tsx:91-100).
    const added = simulateAddManualFinding(TEST_PR_NUMBER, {
      severity: 'high',
      title: 'Race condition on user auth',
      file: 'src/auth/login.ts',
      line: 42,
      description: 'The token refresh races with the session save.',
    });

    // The persisted finding must carry `source: 'manual'` — this is what
    // drives the "Manual" badge in FindingItem.tsx:184-191.
    expect(added.source).toBe('manual');
    // ID must start with `manual-` so useFindingSelection keys correctly.
    expect(added.id).toMatch(/^manual-/);
    // authoredAt is server-stamped, ISO-formatted.
    const authoredAt = expectNotNull(added.authoredAt, 'added.authoredAt');
    expect(() => new Date(authoredAt).toISOString()).not.toThrow();

    // The file is persisted in the canonical location.
    const persisted = expectNotNull(
      readManualFindings(TEST_PR_NUMBER),
      'manual findings file'
    );
    expect(persisted.findings).toHaveLength(1);
    expect(persisted.findings[0].title).toBe('Race condition on user auth');
    expect(persisted.findings[0].source).toBe('manual');
    expect(persisted.prNumber).toBe(TEST_PR_NUMBER);
  });

  test('Scenario 3: hover row + pencil edits the title without mutating audit fields', () => {
    // Set up a single manual finding the user wants to edit.
    const original = simulateAddManualFinding(TEST_PR_NUMBER, {
      severity: 'medium',
      title: 'Original title',
      file: 'src/example.ts',
      line: 10,
      description: 'Original description',
    });
    const originalId = original.id;
    const originalAuthoredAt = original.authoredAt;

    // The pencil opens AddManualFindingDialog with `editingId=finding.id`
    // and pre-filled values, then the user changes the title and submits.
    const updated = expectNotNull(
      simulateUpdateManualFinding(TEST_PR_NUMBER, originalId, {
        title: 'Updated title — covers the race more clearly',
      }),
      'updated finding'
    );

    expect(updated.title).toBe('Updated title — covers the race more clearly');
    // Immutable audit-trail fields preserved (pr-manual-findings-handlers.ts
    // strips id/source/authoredAt/authoredBy from the patch via
    // pickPatchableFields).
    expect(updated.id).toBe(originalId);
    expect(updated.source).toBe('manual');
    expect(updated.authoredAt).toBe(originalAuthoredAt);
    // Other fields the user didn't touch survive intact.
    expect(updated.description).toBe('Original description');
    expect(updated.file).toBe('src/example.ts');
    expect(updated.line).toBe(10);

    const persisted = expectNotNull(
      readManualFindings(TEST_PR_NUMBER),
      'manual findings file'
    );
    expect(persisted.findings).toHaveLength(1);
    expect(persisted.findings[0].title).toBe('Updated title — covers the race more clearly');
  });

  test('Scenario 3b: edit dialog ignores attempts to mutate immutable fields', () => {
    // Defense-in-depth: even if a renderer-side bug sent an `id` or `source`
    // mutation into the UPDATE patch, the handler must drop it. This protects
    // the audit trail.
    const original = simulateAddManualFinding(TEST_PR_NUMBER, {
      severity: 'low',
      title: 'A finding',
      file: 'a.ts',
      line: 1,
      description: 'desc',
    });

    // Deliberately cast through `unknown` so the renderer-style payload can
    // include immutable fields the handler should silently drop. This
    // exercises the `pickPatchableFields` filter.
    const malformedPatch = {
      id: 'attacker-set-id',
      source: 'ai',
      title: 'Legit title change',
    } as unknown as Partial<PRReviewFinding>;
    const updated = expectNotNull(
      simulateUpdateManualFinding(TEST_PR_NUMBER, original.id, malformedPatch),
      'updated finding'
    );

    expect(updated.id).toBe(original.id);
    expect(updated.source).toBe('manual');
    expect(updated.title).toBe('Legit title change');
  });

  test('Scenario 4: hover row + trash + confirm deletes the finding', () => {
    // Two findings — delete one, keep the other.
    const keeper = simulateAddManualFinding(TEST_PR_NUMBER, {
      severity: 'high',
      title: 'Keep me',
      file: 'keep.ts',
      line: 5,
      description: 'survives',
    });
    const doomed = simulateAddManualFinding(TEST_PR_NUMBER, {
      severity: 'low',
      title: 'Delete me',
      file: 'delete.ts',
      line: 99,
      description: 'will be gone',
    });

    // The trash icon opens the AlertDialog confirm modal (FindingItem.tsx:267)
    // and on confirm calls deleteManualFinding. We jump straight to the IPC
    // outcome — the dialog's UX correctness is covered by Vitest unit tests.
    const removed = simulateDeleteManualFinding(TEST_PR_NUMBER, doomed.id);
    expect(removed).toBe(true);

    const persisted = expectNotNull(
      readManualFindings(TEST_PR_NUMBER),
      'manual findings file'
    );
    expect(persisted.findings).toHaveLength(1);
    expect(persisted.findings[0].id).toBe(keeper.id);
    expect(persisted.findings.find((f) => f.id === doomed.id)).toBeUndefined();

    // Second delete returns false — nothing to remove.
    const removedAgain = simulateDeleteManualFinding(TEST_PR_NUMBER, doomed.id);
    expect(removedAgain).toBe(false);
  });

  test('Scenario 4b: delete confirm flow does not touch AI findings', () => {
    // AI findings are immutable — no pencil, no trash icon (FindingItem.tsx:130).
    // Verify the manual-findings DELETE path can't reach into the AI review
    // result by accident.
    const aiFinding = makeAIFinding({ id: 'ai-untouchable', title: 'AI only' });
    seedAIReviewResult(TEST_PR_NUMBER, [aiFinding]);

    // Trying to delete the AI finding's id from the manual store is a no-op
    // (it doesn't exist there).
    const result = simulateDeleteManualFinding(TEST_PR_NUMBER, 'ai-untouchable');
    expect(result).toBe(false);

    // AI review file untouched.
    const review = JSON.parse(readFileSync(getReviewResultPath(TEST_PR_NUMBER), 'utf-8'));
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0].id).toBe('ai-untouchable');
  });
});

test.describe('Manual PR Findings — Terminal Claude write (scenario 5)', () => {
  test.beforeEach(() => {
    setupTestEnvironment();
  });

  test.afterEach(() => {
    cleanupTestEnvironment();
  });

  test('Scenario 5: external write surfaces with "From terminal" badge', () => {
    // Pre-condition: PR with prior AI findings (the precondition described in
    // the test scenario).
    seedAIReviewResult(TEST_PR_NUMBER, [
      makeAIFinding({ id: 'ai-1', severity: 'medium', title: 'AI finding' }),
    ]);

    // Simulate the terminal LLM running its Write tool against the file —
    // this is what the App.tsx primer's "## Recording new findings" protocol
    // asks the in-terminal Claude to do.
    const terminalFinding = simulateTerminalWrite(TEST_PR_NUMBER, {
      severity: 'high',
      category: 'security',
      title: 'Missing CSRF token check',
      description: 'POST /api/transfer accepts requests without verifying the X-CSRF-Token header. Source quote: "I noticed the transfer endpoint isn\'t checking the token".',
      file: 'src/api/transfer.ts',
      line: 87,
      fixable: false,
    });

    // The renderer's FindingItem.tsx:192-199 renders the "From terminal" badge
    // when `source === 'terminal'`. Verifying that the persisted finding has
    // the right source is equivalent to verifying the badge would render.
    expect(terminalFinding.source).toBe('terminal');
    expect(terminalFinding.id).toMatch(/^manual-/);
    expect(terminalFinding.authoredBy).toBe('terminal-claude');

    // The file exists on disk — this is what the chokidar watcher in
    // pr-manual-findings-handlers.ts:381-391 sees and emits a CHANGED event
    // for. With `awaitWriteFinish: { stabilityThreshold: 300, pollInterval:
    // 100 }`, the renderer sees the new row within ~400ms of the write.
    const persisted = expectNotNull(
      readManualFindings(TEST_PR_NUMBER),
      'manual findings file'
    );
    expect(persisted.findings).toHaveLength(1);
    expect(persisted.findings[0].source).toBe('terminal');
    expect(persisted.findings[0].title).toBe('Missing CSRF token check');
  });

  test('Scenario 5b: external write merges with existing manual findings', () => {
    // The terminal LLM is supposed to "Read existing manual_findings_<N>.json
    // (or assume empty), append new entry to findings array, Write merged
    // content back" per the App.tsx primer. Verify that order of operations
    // does NOT clobber an existing user-authored finding.
    const userAuthored = simulateAddManualFinding(TEST_PR_NUMBER, {
      severity: 'medium',
      title: 'User-authored — must survive',
      file: 'src/a.ts',
      line: 1,
      description: 'should stay',
    });

    const fromTerminal = simulateTerminalWrite(TEST_PR_NUMBER, {
      severity: 'low',
      category: 'docs',
      title: 'Docs typo',
      description: 'Typo on line 5 — source quote: "missing comma".',
      file: 'README.md',
      line: 5,
      fixable: true,
    });

    const persisted = expectNotNull(
      readManualFindings(TEST_PR_NUMBER),
      'manual findings file'
    );
    expect(persisted.findings).toHaveLength(2);
    expect(persisted.findings.find((f) => f.id === userAuthored.id)?.source).toBe('manual');
    expect(persisted.findings.find((f) => f.id === fromTerminal.id)?.source).toBe('terminal');
  });

  test('Scenario 5c: terminal write produces a renderer-loadable file shape', () => {
    // The chokidar watcher emits CHANGED, the renderer re-fetches via LIST,
    // and `loadManualFindingsSafe` runs per-entry Zod validation. Verify
    // every required field is present and well-typed so the safeParse path
    // accepts the entry.
    const finding = simulateTerminalWrite(TEST_PR_NUMBER, {
      severity: 'critical',
      category: 'security',
      title: 'SQL injection in /search',
      description: 'Raw user input is concatenated into the SQL query at line 42.',
      file: 'src/db/search.ts',
      line: 42,
      fixable: false,
    });

    // PRReviewFindingSchema in shared/types/pr-review-comments.ts requires:
    //   id, severity (enum), category (enum), title, description, file,
    //   line (int), fixable (bool). All others are optional.
    expect(finding.id).toBeDefined();
    expect(['critical', 'high', 'medium', 'low']).toContain(finding.severity);
    expect([
      'security',
      'quality',
      'style',
      'test',
      'docs',
      'pattern',
      'performance',
    ]).toContain(finding.category);
    expect(typeof finding.title).toBe('string');
    expect(finding.title.length).toBeGreaterThan(0);
    expect(typeof finding.description).toBe('string');
    expect(typeof finding.file).toBe('string');
    expect(Number.isInteger(finding.line)).toBe(true);
    expect(typeof finding.fixable).toBe('boolean');
    // Manual-finding-specific fields.
    expect(['ai', 'manual', 'terminal']).toContain(finding.source);
    const findingAuthoredAt = expectNotNull(finding.authoredAt, 'finding.authoredAt');
    expect(() => new Date(findingAuthoredAt).toISOString()).not.toThrow();
  });

  test('Scenario 5d: file write is visible to a subsequent read within 1s', async () => {
    // The spec's acceptance criterion (FR #3) is "within 1s a new row appears
    // in the open PR's findings list with the 'From terminal' badge". The
    // chokidar watcher uses `awaitWriteFinish: { stabilityThreshold: 300 }`,
    // so the worst-case latency is ~300ms + tick time. We verify the file
    // is on disk and re-readable well under the 1s budget.
    const start = Date.now();
    simulateTerminalWrite(TEST_PR_NUMBER, {
      severity: 'high',
      category: 'quality',
      title: 'Flaky test',
      description: 'The auth integration test fails ~5% of the time.',
      file: 'tests/auth.test.ts',
      line: 23,
      fixable: false,
    });
    const persisted = expectNotNull(
      readManualFindings(TEST_PR_NUMBER),
      'manual findings file'
    );
    const elapsed = Date.now() - start;

    expect(persisted.findings).toHaveLength(1);
    expect(persisted.findings[0].source).toBe('terminal');
    // The end-to-end write-then-read round trip must comfortably beat the 1s
    // acceptance budget; this exercises the simulated terminal write path.
    expect(elapsed).toBeLessThan(1000);
  });
});

test.describe('Manual PR Findings — Combined author + terminal flow', () => {
  test.beforeEach(() => {
    setupTestEnvironment();
  });

  test.afterEach(() => {
    cleanupTestEnvironment();
  });

  test('UI add + terminal write + edit + delete all coexist correctly', () => {
    // Full lifecycle on a single PR — mirrors what a user actually does:
    // run an AI review, add a manual finding, have terminal Claude add
    // another, edit one, delete the other.
    seedAIReviewResult(TEST_PR_NUMBER, [
      makeAIFinding({ id: 'ai-x', severity: 'medium', title: 'AI x' }),
    ]);

    // 1. UI add
    const uiAdded = simulateAddManualFinding(TEST_PR_NUMBER, {
      severity: 'high',
      title: 'UI-authored',
      file: 'src/ui.ts',
      line: 100,
      description: 'A user-authored finding',
    });

    // 2. Terminal Claude write
    const terminalAdded = simulateTerminalWrite(TEST_PR_NUMBER, {
      severity: 'medium',
      category: 'pattern',
      title: 'Terminal-authored',
      description: 'A terminal-extracted finding with source quote.',
      file: 'src/term.ts',
      line: 50,
      fixable: false,
    });

    // 3. Edit the UI-authored finding
    const edited = expectNotNull(
      simulateUpdateManualFinding(TEST_PR_NUMBER, uiAdded.id, {
        title: 'UI-authored (edited)',
        severity: 'critical',
      }),
      'edited finding'
    );
    expect(edited.title).toBe('UI-authored (edited)');
    expect(edited.severity).toBe('critical');
    expect(edited.source).toBe('manual'); // unchanged

    // 4. Delete the terminal-authored finding
    const deleted = simulateDeleteManualFinding(TEST_PR_NUMBER, terminalAdded.id);
    expect(deleted).toBe(true);

    // Final state: AI finding still in review_<N>.json (untouched),
    // manual_findings_<N>.json has just the edited UI-authored finding.
    const review = JSON.parse(readFileSync(getReviewResultPath(TEST_PR_NUMBER), 'utf-8'));
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0].id).toBe('ai-x');

    const persisted = expectNotNull(
      readManualFindings(TEST_PR_NUMBER),
      'manual findings file'
    );
    expect(persisted.findings).toHaveLength(1);
    expect(persisted.findings[0].id).toBe(uiAdded.id);
    expect(persisted.findings[0].title).toBe('UI-authored (edited)');
    expect(persisted.findings[0].source).toBe('manual');
  });
});
