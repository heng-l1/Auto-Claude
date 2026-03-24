/**
 * Tests for worktree branch validation logic.
 *
 * Issue #1479: When cleaning up a corrupted worktree, git rev-parse walks up
 * to the main project and returns its current branch instead of the worktree's branch.
 * This could cause deletion of the wrong branch.
 *
 * These tests verify the validation logic that prevents this.
 */

import { describe, expect, it } from 'vitest';
import { GIT_BRANCH_REGEX, validateWorktreeBranch } from '../worktree-handlers';

describe('GIT_BRANCH_REGEX', () => {
  it('should accept valid auto-claude branch names', () => {
    expect(GIT_BRANCH_REGEX.test('auto-claude/my-feature')).toBe(true);
    expect(GIT_BRANCH_REGEX.test('auto-claude/123-fix-bug')).toBe(true);
    expect(GIT_BRANCH_REGEX.test('auto-claude/feature_with_underscore')).toBe(true);
  });

  it('should accept valid feature branch names', () => {
    expect(GIT_BRANCH_REGEX.test('feature/my-feature')).toBe(true);
    expect(GIT_BRANCH_REGEX.test('fix/bug-123')).toBe(true);
    expect(GIT_BRANCH_REGEX.test('main')).toBe(true);
    expect(GIT_BRANCH_REGEX.test('develop')).toBe(true);
  });

  it('should accept single character branch names', () => {
    expect(GIT_BRANCH_REGEX.test('a')).toBe(true);
    expect(GIT_BRANCH_REGEX.test('1')).toBe(true);
  });

  it('should reject invalid branch names', () => {
    expect(GIT_BRANCH_REGEX.test('')).toBe(false);
    expect(GIT_BRANCH_REGEX.test('-invalid')).toBe(false);
    expect(GIT_BRANCH_REGEX.test('invalid-')).toBe(false);
    expect(GIT_BRANCH_REGEX.test('.invalid')).toBe(false);
  });

  it('should accept HEAD as syntactically valid (handled specially in validation logic)', () => {
    // HEAD is technically valid as a git branch name syntactically,
    // but when detected from rev-parse it indicates detached state.
    // The validateWorktreeBranch function handles this case specially.
    expect(GIT_BRANCH_REGEX.test('HEAD')).toBe(true);
  });

  it('should accept custom prefix branch names', () => {
    expect(GIT_BRANCH_REGEX.test('user/my-feature')).toBe(true);
    expect(GIT_BRANCH_REGEX.test('user/001-task')).toBe(true);
    expect(GIT_BRANCH_REGEX.test('my-team/feature-xyz')).toBe(true);
    expect(GIT_BRANCH_REGEX.test('user123/fix-bug')).toBe(true);
  });
});

describe('validateWorktreeBranch', () => {
  const expectedBranch = 'auto-claude/my-feature-123';

  describe('exact match scenarios', () => {
    it('should use detected branch when it matches expected exactly', () => {
      const result = validateWorktreeBranch('auto-claude/my-feature-123', expectedBranch);
      expect(result.branchToDelete).toBe('auto-claude/my-feature-123');
      expect(result.usedFallback).toBe(false);
      expect(result.reason).toBe('exact_match');
    });
  });

  describe('pattern match scenarios', () => {
    it('should allow other auto-claude branches (specId renamed)', () => {
      const result = validateWorktreeBranch('auto-claude/renamed-feature', expectedBranch);
      expect(result.branchToDelete).toBe('auto-claude/renamed-feature');
      expect(result.usedFallback).toBe(false);
      expect(result.reason).toBe('pattern_match');
    });

    it('should allow auto-claude branches with different formats', () => {
      const result = validateWorktreeBranch('auto-claude/001-task', expectedBranch);
      expect(result.branchToDelete).toBe('auto-claude/001-task');
      expect(result.usedFallback).toBe(false);
      expect(result.reason).toBe('pattern_match');
    });
  });

  describe('security: corrupted worktree scenarios (issue #1479)', () => {
    it('should reject main project branch and use expected pattern', () => {
      // This is the critical case: corrupted worktree returns main project's branch
      const result = validateWorktreeBranch('feature/xstate-task-machine', expectedBranch);
      expect(result.branchToDelete).toBe(expectedBranch);
      expect(result.usedFallback).toBe(true);
      expect(result.reason).toBe('invalid_pattern');
    });

    it('should reject develop branch', () => {
      const result = validateWorktreeBranch('develop', expectedBranch);
      expect(result.branchToDelete).toBe(expectedBranch);
      expect(result.usedFallback).toBe(true);
      expect(result.reason).toBe('invalid_pattern');
    });

    it('should reject main branch', () => {
      const result = validateWorktreeBranch('main', expectedBranch);
      expect(result.branchToDelete).toBe(expectedBranch);
      expect(result.usedFallback).toBe(true);
      expect(result.reason).toBe('invalid_pattern');
    });

    it('should reject master branch', () => {
      const result = validateWorktreeBranch('master', expectedBranch);
      expect(result.branchToDelete).toBe(expectedBranch);
      expect(result.usedFallback).toBe(true);
      expect(result.reason).toBe('invalid_pattern');
    });

    it('should reject fix/ branches from main project', () => {
      const result = validateWorktreeBranch('fix/some-bug', expectedBranch);
      expect(result.branchToDelete).toBe(expectedBranch);
      expect(result.usedFallback).toBe(true);
      expect(result.reason).toBe('invalid_pattern');
    });

    it('should reject feature/ branches from main project', () => {
      const result = validateWorktreeBranch('feature/new-feature', expectedBranch);
      expect(result.branchToDelete).toBe(expectedBranch);
      expect(result.usedFallback).toBe(true);
      expect(result.reason).toBe('invalid_pattern');
    });
  });

  describe('detection failure scenarios', () => {
    it('should use expected pattern when detection returns null', () => {
      const result = validateWorktreeBranch(null, expectedBranch);
      expect(result.branchToDelete).toBe(expectedBranch);
      expect(result.usedFallback).toBe(true);
      expect(result.reason).toBe('detection_failed');
    });
  });

  describe('edge cases', () => {
    it('should handle empty detected branch', () => {
      const result = validateWorktreeBranch('', expectedBranch);
      expect(result.branchToDelete).toBe(expectedBranch);
      expect(result.usedFallback).toBe(true);
      expect(result.reason).toBe('invalid_pattern');
    });

    it('should handle HEAD (detached state)', () => {
      const result = validateWorktreeBranch('HEAD', expectedBranch);
      expect(result.branchToDelete).toBe(expectedBranch);
      expect(result.usedFallback).toBe(true);
      expect(result.reason).toBe('invalid_pattern');
    });

    it('should handle branch that starts with auto-claude but is malformed', () => {
      // "auto-claude" without a slash should still be rejected
      const result = validateWorktreeBranch('auto-claude', expectedBranch);
      expect(result.branchToDelete).toBe(expectedBranch);
      expect(result.usedFallback).toBe(true);
      expect(result.reason).toBe('invalid_pattern');
    });

    it('should reject auto-claude/ with no suffix (invalid branch name)', () => {
      // "auto-claude/" alone is not a valid branch name - needs actual specId
      const result = validateWorktreeBranch('auto-claude/', expectedBranch);
      expect(result.branchToDelete).toBe(expectedBranch);
      expect(result.usedFallback).toBe(true);
      expect(result.reason).toBe('invalid_pattern');
    });
  });

  describe('custom branch prefix', () => {
    const customExpectedBranch = 'user/my-feature-123';
    const customPrefix = 'user';

    describe('exact match with custom prefix', () => {
      it('should use detected branch when it matches expected exactly', () => {
        const result = validateWorktreeBranch('user/my-feature-123', customExpectedBranch, customPrefix);
        expect(result.branchToDelete).toBe('user/my-feature-123');
        expect(result.usedFallback).toBe(false);
        expect(result.reason).toBe('exact_match');
      });
    });

    describe('pattern match with custom prefix', () => {
      it('should allow other branches with the same custom prefix', () => {
        const result = validateWorktreeBranch('user/other-task', customExpectedBranch, customPrefix);
        expect(result.branchToDelete).toBe('user/other-task');
        expect(result.usedFallback).toBe(false);
        expect(result.reason).toBe('pattern_match');
      });

      it('should allow custom prefix branches with numeric specIds', () => {
        const result = validateWorktreeBranch('user/001-task', customExpectedBranch, customPrefix);
        expect(result.branchToDelete).toBe('user/001-task');
        expect(result.usedFallback).toBe(false);
        expect(result.reason).toBe('pattern_match');
      });
    });

    describe('legacy backward compatibility', () => {
      it('should accept legacy auto-claude/ branches when custom prefix is configured', () => {
        // Existing worktrees created before prefix change should still be cleaned up
        const result = validateWorktreeBranch('auto-claude/old-task', customExpectedBranch, customPrefix);
        expect(result.branchToDelete).toBe('auto-claude/old-task');
        expect(result.usedFallback).toBe(false);
        expect(result.reason).toBe('pattern_match');
      });

      it('should accept legacy auto-claude/ branches with any valid specId', () => {
        const result = validateWorktreeBranch('auto-claude/001-some-feature', customExpectedBranch, customPrefix);
        expect(result.branchToDelete).toBe('auto-claude/001-some-feature');
        expect(result.usedFallback).toBe(false);
        expect(result.reason).toBe('pattern_match');
      });

      it('should reject legacy auto-claude/ with no suffix even when custom prefix is configured', () => {
        const result = validateWorktreeBranch('auto-claude/', customExpectedBranch, customPrefix);
        expect(result.branchToDelete).toBe(customExpectedBranch);
        expect(result.usedFallback).toBe(true);
        expect(result.reason).toBe('invalid_pattern');
      });
    });

    describe('security: corrupted worktree scenarios with custom prefix', () => {
      it('should reject main project branch and use expected pattern', () => {
        const result = validateWorktreeBranch('feature/xstate-task-machine', customExpectedBranch, customPrefix);
        expect(result.branchToDelete).toBe(customExpectedBranch);
        expect(result.usedFallback).toBe(true);
        expect(result.reason).toBe('invalid_pattern');
      });

      it('should reject develop branch', () => {
        const result = validateWorktreeBranch('develop', customExpectedBranch, customPrefix);
        expect(result.branchToDelete).toBe(customExpectedBranch);
        expect(result.usedFallback).toBe(true);
        expect(result.reason).toBe('invalid_pattern');
      });

      it('should reject main branch', () => {
        const result = validateWorktreeBranch('main', customExpectedBranch, customPrefix);
        expect(result.branchToDelete).toBe(customExpectedBranch);
        expect(result.usedFallback).toBe(true);
        expect(result.reason).toBe('invalid_pattern');
      });

      it('should reject master branch', () => {
        const result = validateWorktreeBranch('master', customExpectedBranch, customPrefix);
        expect(result.branchToDelete).toBe(customExpectedBranch);
        expect(result.usedFallback).toBe(true);
        expect(result.reason).toBe('invalid_pattern');
      });

      it('should reject fix/ branches from main project', () => {
        const result = validateWorktreeBranch('fix/some-bug', customExpectedBranch, customPrefix);
        expect(result.branchToDelete).toBe(customExpectedBranch);
        expect(result.usedFallback).toBe(true);
        expect(result.reason).toBe('invalid_pattern');
      });

      it('should reject feature/ branches from main project', () => {
        const result = validateWorktreeBranch('feature/new-feature', customExpectedBranch, customPrefix);
        expect(result.branchToDelete).toBe(customExpectedBranch);
        expect(result.usedFallback).toBe(true);
        expect(result.reason).toBe('invalid_pattern');
      });
    });

    describe('edge cases with custom prefix', () => {
      it('should handle detection failure with custom prefix', () => {
        const result = validateWorktreeBranch(null, customExpectedBranch, customPrefix);
        expect(result.branchToDelete).toBe(customExpectedBranch);
        expect(result.usedFallback).toBe(true);
        expect(result.reason).toBe('detection_failed');
      });

      it('should handle empty detected branch with custom prefix', () => {
        const result = validateWorktreeBranch('', customExpectedBranch, customPrefix);
        expect(result.branchToDelete).toBe(customExpectedBranch);
        expect(result.usedFallback).toBe(true);
        expect(result.reason).toBe('invalid_pattern');
      });

      it('should reject custom prefix without slash (malformed)', () => {
        // "user" without a slash should be rejected
        const result = validateWorktreeBranch('user', customExpectedBranch, customPrefix);
        expect(result.branchToDelete).toBe(customExpectedBranch);
        expect(result.usedFallback).toBe(true);
        expect(result.reason).toBe('invalid_pattern');
      });

      it('should reject custom prefix with slash but no suffix', () => {
        // "user/" alone is not a valid branch name - needs actual specId
        const result = validateWorktreeBranch('user/', customExpectedBranch, customPrefix);
        expect(result.branchToDelete).toBe(customExpectedBranch);
        expect(result.usedFallback).toBe(true);
        expect(result.reason).toBe('invalid_pattern');
      });

      it('should handle HEAD (detached state) with custom prefix', () => {
        const result = validateWorktreeBranch('HEAD', customExpectedBranch, customPrefix);
        expect(result.branchToDelete).toBe(customExpectedBranch);
        expect(result.usedFallback).toBe(true);
        expect(result.reason).toBe('invalid_pattern');
      });
    });

    describe('different custom prefixes', () => {
      it('should work with hyphenated prefix', () => {
        const result = validateWorktreeBranch('my-team/task-001', 'my-team/task-001', 'my-team');
        expect(result.branchToDelete).toBe('my-team/task-001');
        expect(result.usedFallback).toBe(false);
        expect(result.reason).toBe('exact_match');
      });

      it('should work with numeric prefix', () => {
        const result = validateWorktreeBranch('user123/feature', 'user123/task-001', 'user123');
        expect(result.branchToDelete).toBe('user123/feature');
        expect(result.usedFallback).toBe(false);
        expect(result.reason).toBe('pattern_match');
      });

      it('should support legacy compat with different custom prefixes', () => {
        const result = validateWorktreeBranch('auto-claude/legacy-task', 'my-team/new-task', 'my-team');
        expect(result.branchToDelete).toBe('auto-claude/legacy-task');
        expect(result.usedFallback).toBe(false);
        expect(result.reason).toBe('pattern_match');
      });
    });
  });

  describe('backward compatibility (no branchPrefix param)', () => {
    it('should behave identically to before when branchPrefix is not provided', () => {
      // All existing behavior is preserved when the optional 3rd param is omitted
      const exactResult = validateWorktreeBranch('auto-claude/my-feature-123', expectedBranch);
      expect(exactResult.reason).toBe('exact_match');

      const patternResult = validateWorktreeBranch('auto-claude/other-task', expectedBranch);
      expect(patternResult.reason).toBe('pattern_match');

      const rejectResult = validateWorktreeBranch('main', expectedBranch);
      expect(rejectResult.reason).toBe('invalid_pattern');
      expect(rejectResult.usedFallback).toBe(true);

      const nullResult = validateWorktreeBranch(null, expectedBranch);
      expect(nullResult.reason).toBe('detection_failed');
      expect(nullResult.usedFallback).toBe(true);
    });

    it('should behave identically when branchPrefix is undefined', () => {
      const result = validateWorktreeBranch('auto-claude/my-feature-123', expectedBranch, undefined);
      expect(result.branchToDelete).toBe('auto-claude/my-feature-123');
      expect(result.usedFallback).toBe(false);
      expect(result.reason).toBe('exact_match');
    });

    it('should behave identically when branchPrefix is empty string', () => {
      // Empty string is falsy, so it falls back to 'auto-claude'
      const result = validateWorktreeBranch('auto-claude/my-feature-123', expectedBranch, '');
      expect(result.branchToDelete).toBe('auto-claude/my-feature-123');
      expect(result.usedFallback).toBe(false);
      expect(result.reason).toBe('exact_match');
    });

    it('should not accept legacy auto-claude/ as pattern_match when using default prefix', () => {
      // When prefix is 'auto-claude' (default), the legacy compat block should NOT activate
      // because prefix === 'auto-claude'. Instead, it should match via the normal prefix check.
      const result = validateWorktreeBranch('auto-claude/some-task', expectedBranch, 'auto-claude');
      expect(result.branchToDelete).toBe('auto-claude/some-task');
      expect(result.usedFallback).toBe(false);
      expect(result.reason).toBe('pattern_match');
    });
  });
});
