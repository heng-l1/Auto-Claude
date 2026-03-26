/**
 * Unit tests for parsePatchForNewFileLines()
 * Tests patch parsing logic that determines valid new-file line numbers
 * for GitHub review API comments.
 */
import { describe, it, expect } from 'vitest';
import { parsePatchForNewFileLines } from '../pr-handlers';

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
