/**
 * Unit tests for parsePatchForNewFileLines() and buildReviewComments()
 * Tests patch parsing logic and comment routing for GitHub review API.
 */
import { describe, it, expect } from 'vitest';
import { parsePatchForNewFileLines, buildReviewComments } from '../pr-handlers';
import type { PRReviewFinding } from '../pr-handlers';

describe('parsePatchForNewFileLines', () => {
  describe('single-hunk patch', () => {
    it('should return correct line numbers for a simple addition-only hunk', () => {
      const patch = [
        '@@ -0,0 +1,3 @@',
        '+line one',
        '+line two',
        '+line three',
      ].join('\n');

      const result = parsePatchForNewFileLines(patch);

      expect(result).toEqual(new Set([1, 2, 3]));
    });

    it('should return correct line numbers starting from a non-1 offset', () => {
      const patch = [
        '@@ -10,3 +15,4 @@',
        ' context line',
        '+added line',
        ' another context',
        '+another addition',
      ].join('\n');

      const result = parsePatchForNewFileLines(patch);

      expect(result).toEqual(new Set([15, 16, 17, 18]));
    });
  });

  describe('multi-hunk patch', () => {
    it('should aggregate line numbers from all hunks', () => {
      const patch = [
        '@@ -1,3 +1,4 @@',
        ' existing line',
        '+new line in hunk 1',
        ' another existing',
        ' more existing',
        '@@ -20,2 +21,3 @@',
        ' context at hunk 2',
        '+new line in hunk 2',
        ' trailing context',
      ].join('\n');

      const result = parsePatchForNewFileLines(patch);

      // Hunk 1: lines 1 (context), 2 (addition), 3 (context), 4 (context)
      // Hunk 2: lines 21 (context), 22 (addition), 23 (context)
      expect(result).toEqual(new Set([1, 2, 3, 4, 21, 22, 23]));
    });

    it('should reset line counter at each hunk header', () => {
      const patch = [
        '@@ -1,1 +1,2 @@',
        ' first',
        '+added after first',
        '@@ -50,1 +51,2 @@',
        ' middle',
        '+added after middle',
      ].join('\n');

      const result = parsePatchForNewFileLines(patch);

      expect(result.has(1)).toBe(true);
      expect(result.has(2)).toBe(true);
      expect(result.has(51)).toBe(true);
      expect(result.has(52)).toBe(true);
      expect(result.size).toBe(4);
    });
  });

  describe('empty and falsy input', () => {
    it('should return empty set for empty string', () => {
      const result = parsePatchForNewFileLines('');

      expect(result).toEqual(new Set());
      expect(result.size).toBe(0);
    });

    it('should return empty set for null input', () => {
      const result = parsePatchForNewFileLines(null);

      expect(result).toEqual(new Set());
      expect(result.size).toBe(0);
    });

    it('should return empty set for undefined input', () => {
      const result = parsePatchForNewFileLines(undefined);

      expect(result).toEqual(new Set());
      expect(result.size).toBe(0);
    });
  });

  describe('context lines (space-prefixed)', () => {
    it('should include context lines as valid commentable lines', () => {
      const patch = [
        '@@ -5,3 +5,3 @@',
        ' context line one',
        ' context line two',
        ' context line three',
      ].join('\n');

      const result = parsePatchForNewFileLines(patch);

      expect(result).toEqual(new Set([5, 6, 7]));
    });
  });

  describe('deletion lines (- prefix)', () => {
    it('should exclude deletion-only lines', () => {
      const patch = [
        '@@ -1,3 +1,1 @@',
        '-deleted line one',
        '-deleted line two',
        ' kept line',
      ].join('\n');

      const result = parsePatchForNewFileLines(patch);

      // Only the context line at new-file line 1 should be included
      expect(result).toEqual(new Set([1]));
      expect(result.size).toBe(1);
    });

    it('should not increment new-file line counter for deletions', () => {
      const patch = [
        '@@ -1,5 +1,3 @@',
        ' first context',
        '-removed line',
        '-another removed',
        ' second context',
        ' third context',
      ].join('\n');

      const result = parsePatchForNewFileLines(patch);

      // New-file lines: 1 (context), skip deletion, skip deletion, 2 (context), 3 (context)
      expect(result).toEqual(new Set([1, 2, 3]));
    });
  });

  describe('mixed additions/deletions/context in one hunk', () => {
    it('should correctly handle interleaved additions, deletions, and context', () => {
      const patch = [
        '@@ -1,6 +1,6 @@',
        ' unchanged first line',
        '-old second line',
        '+new second line',
        ' unchanged third line',
        '-old fourth line',
        '+new fourth line',
        ' unchanged fifth line',
        ' unchanged sixth line',
      ].join('\n');

      const result = parsePatchForNewFileLines(patch);

      // Line tracking:
      // " unchanged first line"  -> new line 1 (context, included)
      // "- old second line"      -> deletion, no increment
      // "+ new second line"      -> new line 2 (addition, included)
      // " unchanged third line"  -> new line 3 (context, included)
      // "- old fourth line"      -> deletion, no increment
      // "+ new fourth line"      -> new line 4 (addition, included)
      // " unchanged fifth line"  -> new line 5 (context, included)
      // " unchanged sixth line"  -> new line 6 (context, included)
      expect(result).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    });

    it('should handle consecutive additions correctly', () => {
      const patch = [
        '@@ -1,2 +1,5 @@',
        ' existing line',
        '+added line 1',
        '+added line 2',
        '+added line 3',
        ' another existing',
      ].join('\n');

      const result = parsePatchForNewFileLines(patch);

      expect(result).toEqual(new Set([1, 2, 3, 4, 5]));
    });

    it('should handle consecutive deletions followed by additions', () => {
      const patch = [
        '@@ -1,4 +1,3 @@',
        '-deleted one',
        '-deleted two',
        '+replacement line',
        ' context line',
        ' more context',
      ].join('\n');

      const result = parsePatchForNewFileLines(patch);

      // Deletions don't increment; addition at line 1, context at 2, context at 3
      expect(result).toEqual(new Set([1, 2, 3]));
    });
  });

  describe('real-world GitHub patch format', () => {
    it('should handle @@ header with context text after the second @@', () => {
      const patch = [
        '@@ -10,7 +10,8 @@ export function setupRoutes(app: Express) {',
        '   const router = Router();',
        '   router.get("/health", healthCheck);',
        '+  router.get("/status", statusCheck);',
        '   router.post("/api/data", handleData);',
        '   app.use(router);',
        ' }',
        ' ',
      ].join('\n');

      const result = parsePatchForNewFileLines(patch);

      expect(result).toEqual(new Set([10, 11, 12, 13, 14, 15, 16]));
    });

    it('should handle "No newline at end of file" marker', () => {
      const patch = [
        '@@ -1,3 +1,4 @@',
        ' line one',
        ' line two',
        ' line three',
        '+line four',
        '\\ No newline at end of file',
      ].join('\n');

      const result = parsePatchForNewFileLines(patch);

      // The "\\" line should be skipped entirely
      expect(result).toEqual(new Set([1, 2, 3, 4]));
    });

    it('should handle a new file patch (added from scratch)', () => {
      const patch = [
        '@@ -0,0 +1,5 @@',
        '+import { describe } from "vitest";',
        '+',
        '+describe("example", () => {',
        '+  // test body',
        '+});',
      ].join('\n');

      const result = parsePatchForNewFileLines(patch);

      expect(result).toEqual(new Set([1, 2, 3, 4, 5]));
    });

    it('should handle multi-hunk real-world patch with function context', () => {
      const patch = [
        '@@ -15,6 +15,7 @@ import { Logger } from "./logger";',
        ' ',
        ' const DEFAULT_TIMEOUT = 5000;',
        '+const MAX_RETRIES = 3;',
        ' ',
        ' export class ApiClient {',
        '   private baseUrl: string;',
        '@@ -45,4 +46,8 @@ export class ApiClient {',
        '     return response.json();',
        '   }',
        '+',
        '+  async retry(fn: () => Promise<unknown>): Promise<unknown> {',
        '+    return fn();',
        '+  }',
        ' }',
      ].join('\n');

      const result = parsePatchForNewFileLines(patch);

      // Hunk 1: lines 15-21 (15,16=context, 17=add, 18,19,20=context)
      // Hunk 2: lines 46-53 (46,47=context, 48-51=additions, 52=context)
      expect(result.has(17)).toBe(true); // MAX_RETRIES addition
      expect(result.has(48)).toBe(true); // blank line addition
      expect(result.has(49)).toBe(true); // retry method
      expect(result.has(50)).toBe(true); // return fn()
      expect(result.has(51)).toBe(true); // closing brace
    });

    it('should skip lines before the first hunk header', () => {
      // Some patches can have diff metadata before the first @@
      const patch = [
        'diff --git a/file.ts b/file.ts',
        'index abc123..def456 100644',
        '--- a/file.ts',
        '+++ b/file.ts',
        '@@ -1,3 +1,4 @@',
        ' first line',
        '+inserted line',
        ' second line',
        ' third line',
      ].join('\n');

      const result = parsePatchForNewFileLines(patch);

      expect(result).toEqual(new Set([1, 2, 3, 4]));
    });
  });
});

/**
 * Helper to create a minimal PRReviewFinding for testing.
 * Only the fields relevant to comment routing are required.
 */
function makeFinding(overrides: Partial<PRReviewFinding> & { file: string; line: number }): PRReviewFinding {
  return {
    id: 'f-1',
    severity: 'medium',
    category: 'quality',
    title: 'Test finding',
    description: 'Test description',
    fixable: false,
    ...overrides,
  };
}

describe('buildReviewComments', () => {
  describe('inline comment routing (line in diff)', () => {
    it('should produce an inline comment with path and line when line is in the diff', () => {
      const fileLineMap = new Map<string, Set<number>>([
        ['src/index.ts', new Set([10, 11, 12])],
      ]);
      const findings = [makeFinding({ file: 'src/index.ts', line: 11 })];

      const comments = buildReviewComments(findings, fileLineMap);

      expect(comments).toHaveLength(1);
      expect(comments[0].path).toBe('src/index.ts');
      expect(comments[0].line).toBe(11);
      expect(comments[0].subject_type).toBeUndefined();
      expect(comments[0].body).toContain('**[MEDIUM] Test finding**');
    });

    it('should include severity emoji in inline comment body', () => {
      const fileLineMap = new Map<string, Set<number>>([
        ['src/main.ts', new Set([5])],
      ]);

      const criticalFinding = makeFinding({ file: 'src/main.ts', line: 5, severity: 'critical', title: 'Critical bug' });
      const comments = buildReviewComments([criticalFinding], fileLineMap);

      expect(comments[0].body).toMatch(/^🔴/);
      expect(comments[0].body).toContain('**[CRITICAL] Critical bug**');
    });

    it('should include suggested fix in inline comment body when present', () => {
      const fileLineMap = new Map<string, Set<number>>([
        ['src/app.ts', new Set([1])],
      ]);
      const finding = makeFinding({
        file: 'src/app.ts',
        line: 1,
        suggestedFix: 'return true;',
      });

      const comments = buildReviewComments([finding], fileLineMap);

      expect(comments[0].body).toContain('**Suggested fix:**');
      expect(comments[0].body).toContain('return true;');
    });
  });

  describe('file-level comment routing (line NOT in diff)', () => {
    it('should produce a file-level comment with subject_type "file" when line is not in the diff', () => {
      const fileLineMap = new Map<string, Set<number>>([
        ['src/utils.ts', new Set([1, 2, 3])],
      ]);
      // Line 50 is NOT in the diff (only lines 1-3 are)
      const findings = [makeFinding({ file: 'src/utils.ts', line: 50 })];

      const comments = buildReviewComments(findings, fileLineMap);

      expect(comments).toHaveLength(1);
      expect(comments[0].path).toBe('src/utils.ts');
      expect(comments[0].line).toBeUndefined();
      expect(comments[0].subject_type).toBe('file');
    });

    it('should prefix file-level comment body with "> Line N:" hint', () => {
      const fileLineMap = new Map<string, Set<number>>([
        ['src/config.ts', new Set([10])],
      ]);
      const findings = [makeFinding({ file: 'src/config.ts', line: 99, title: 'Unused var' })];

      const comments = buildReviewComments(findings, fileLineMap);

      expect(comments[0].body).toMatch(/^> Line 99: /);
      expect(comments[0].body).toContain('**[MEDIUM] Unused var**');
    });
  });

  describe('skipping findings for files not in PR', () => {
    it('should skip a finding whose file is not present in the fileLineMap', () => {
      const fileLineMap = new Map<string, Set<number>>([
        ['src/included.ts', new Set([1, 2])],
      ]);
      // This file is not in the PR at all
      const findings = [makeFinding({ file: 'src/not-in-pr.ts', line: 5 })];

      const comments = buildReviewComments(findings, fileLineMap);

      expect(comments).toHaveLength(0);
    });

    it('should only include comments for files that are in the PR', () => {
      const fileLineMap = new Map<string, Set<number>>([
        ['src/a.ts', new Set([1])],
      ]);
      const findings = [
        makeFinding({ id: 'f-1', file: 'src/a.ts', line: 1 }),
        makeFinding({ id: 'f-2', file: 'src/b.ts', line: 1 }),
        makeFinding({ id: 'f-3', file: 'src/c.ts', line: 1 }),
      ];

      const comments = buildReviewComments(findings, fileLineMap);

      // Only the finding for src/a.ts should produce a comment
      expect(comments).toHaveLength(1);
      expect(comments[0].path).toBe('src/a.ts');
    });
  });

  describe('path normalization', () => {
    it('should strip leading "./" from finding paths', () => {
      const fileLineMap = new Map<string, Set<number>>([
        ['src/handler.ts', new Set([10])],
      ]);
      // Finding path has leading "./" which should be stripped to match the map key
      const findings = [makeFinding({ file: './src/handler.ts', line: 10 })];

      const comments = buildReviewComments(findings, fileLineMap);

      expect(comments).toHaveLength(1);
      expect(comments[0].path).toBe('src/handler.ts');
      expect(comments[0].line).toBe(10);
    });

    it('should not modify paths without leading "./"', () => {
      const fileLineMap = new Map<string, Set<number>>([
        ['src/router.ts', new Set([5])],
      ]);
      const findings = [makeFinding({ file: 'src/router.ts', line: 5 })];

      const comments = buildReviewComments(findings, fileLineMap);

      expect(comments[0].path).toBe('src/router.ts');
    });

    it('should strip leading "./" for file-level comments too', () => {
      const fileLineMap = new Map<string, Set<number>>([
        ['lib/utils.ts', new Set([1])],
      ]);
      // Line 999 is out of diff, but path has "./" prefix
      const findings = [makeFinding({ file: './lib/utils.ts', line: 999 })];

      const comments = buildReviewComments(findings, fileLineMap);

      expect(comments).toHaveLength(1);
      expect(comments[0].path).toBe('lib/utils.ts');
      expect(comments[0].subject_type).toBe('file');
    });
  });

  describe('null fileLineMap fallback (all-inline behavior)', () => {
    it('should produce inline comments for all findings when fileLineMap is null', () => {
      const findings = [
        makeFinding({ id: 'f-1', file: 'src/a.ts', line: 10 }),
        makeFinding({ id: 'f-2', file: 'src/b.ts', line: 20 }),
        makeFinding({ id: 'f-3', file: 'src/c.ts', line: 30 }),
      ];

      const comments = buildReviewComments(findings, null);

      expect(comments).toHaveLength(3);
      // All should have line numbers (inline), no subject_type
      for (const comment of comments) {
        expect(comment.line).toBeDefined();
        expect(comment.subject_type).toBeUndefined();
      }
    });

    it('should normalize paths even when fileLineMap is null', () => {
      const findings = [makeFinding({ file: './src/test.ts', line: 5 })];

      const comments = buildReviewComments(findings, null);

      expect(comments).toHaveLength(1);
      expect(comments[0].path).toBe('src/test.ts');
      expect(comments[0].line).toBe(5);
    });

    it('should not skip any files when fileLineMap is null', () => {
      const findings = [
        makeFinding({ id: 'f-1', file: 'any/random/file.ts', line: 1 }),
        makeFinding({ id: 'f-2', file: 'another/file.ts', line: 2 }),
      ];

      const comments = buildReviewComments(findings, null);

      // No files are skipped when fileLineMap is null
      expect(comments).toHaveLength(2);
    });
  });

  describe('mixed routing scenarios', () => {
    it('should correctly route inline, file-level, and skipped findings in one call', () => {
      const fileLineMap = new Map<string, Set<number>>([
        ['src/changed.ts', new Set([10, 11, 12])],
        ['src/also-changed.ts', new Set([1, 2])],
      ]);
      const findings = [
        // Inline: line 10 is in the diff for src/changed.ts
        makeFinding({ id: 'inline', file: 'src/changed.ts', line: 10, severity: 'high', title: 'Inline' }),
        // File-level: line 99 is NOT in the diff but file is in the PR
        makeFinding({ id: 'file-level', file: 'src/also-changed.ts', line: 99, severity: 'low', title: 'File-level' }),
        // Skipped: file not in PR at all
        makeFinding({ id: 'skipped', file: 'src/untouched.ts', line: 5, severity: 'medium', title: 'Skipped' }),
      ];

      const comments = buildReviewComments(findings, fileLineMap);

      // Only 2 comments (the skipped finding is omitted)
      expect(comments).toHaveLength(2);

      // Inline comment
      const inlineComment = comments.find(c => c.line !== undefined);
      expect(inlineComment).toBeDefined();
      expect(inlineComment?.path).toBe('src/changed.ts');
      expect(inlineComment?.line).toBe(10);
      expect(inlineComment?.subject_type).toBeUndefined();

      // File-level comment
      const fileLevelComment = comments.find(c => c.subject_type === 'file');
      expect(fileLevelComment).toBeDefined();
      expect(fileLevelComment?.path).toBe('src/also-changed.ts');
      expect(fileLevelComment?.line).toBeUndefined();
      expect(fileLevelComment?.body).toMatch(/^> Line 99: /);
    });

    it('should skip findings with no file or non-positive line', () => {
      const fileLineMap = new Map<string, Set<number>>([
        ['src/a.ts', new Set([1])],
      ]);
      const findings = [
        makeFinding({ file: '', line: 10 }),
        makeFinding({ file: 'src/a.ts', line: 0 }),
        makeFinding({ file: 'src/a.ts', line: -1 }),
        makeFinding({ file: 'src/a.ts', line: 1 }), // only this one should produce a comment
      ];

      const comments = buildReviewComments(findings, fileLineMap);

      expect(comments).toHaveLength(1);
      expect(comments[0].path).toBe('src/a.ts');
      expect(comments[0].line).toBe(1);
    });

    it('should handle all severity emojis correctly', () => {
      const fileLineMap = new Map<string, Set<number>>([
        ['src/file.ts', new Set([1, 2, 3, 4])],
      ]);
      const findings = [
        makeFinding({ id: 'f-1', file: 'src/file.ts', line: 1, severity: 'critical', title: 'Crit' }),
        makeFinding({ id: 'f-2', file: 'src/file.ts', line: 2, severity: 'high', title: 'High' }),
        makeFinding({ id: 'f-3', file: 'src/file.ts', line: 3, severity: 'medium', title: 'Med' }),
        makeFinding({ id: 'f-4', file: 'src/file.ts', line: 4, severity: 'low', title: 'Low' }),
      ];

      const comments = buildReviewComments(findings, fileLineMap);

      expect(comments[0].body).toMatch(/^🔴/);
      expect(comments[1].body).toMatch(/^🟠/);
      expect(comments[2].body).toMatch(/^🟡/);
      expect(comments[3].body).toMatch(/^🔵/);
    });
  });

  describe('empty findings', () => {
    it('should return empty array for empty findings list', () => {
      const fileLineMap = new Map<string, Set<number>>([
        ['src/file.ts', new Set([1])],
      ]);

      const comments = buildReviewComments([], fileLineMap);

      expect(comments).toEqual([]);
    });

    it('should return empty array for empty findings with null fileLineMap', () => {
      const comments = buildReviewComments([], null);

      expect(comments).toEqual([]);
    });
  });
});
