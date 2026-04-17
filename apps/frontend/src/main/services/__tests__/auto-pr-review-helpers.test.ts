/**
 * Tests for auto-pr-review-helpers.ts
 *
 * Unit tests covering the two exported helpers:
 *
 * - enableAutoPRReviewForProject:
 *   - happy path with override repo (order: setMainWindowGetter → enableForProject)
 *   - fallback to .env GITHUB_REPO when override absent
 *   - empty-string override falls through to .env (|| semantics, not ??)
 *   - returns false when token is null
 *   - returns false when repo missing from both override and .env
 *   - swallows errors from getGitHubTokenForSubprocess (returns false, logs warning)
 *
 * - restoreAutoPRReviewOnStartup:
 *   - empty project list → no-op; logs "Restored 0 of 0"
 *   - skip project without autoBuildPath (no readFileSync for it)
 *   - skip when .env doesn't exist (existsSync false)
 *   - skip when .env lacks GITHUB_AUTO_PR_REVIEW key
 *   - skip when GITHUB_AUTO_PR_REVIEW=false
 *   - flag true but GITHUB_REPO missing → helper invoked, returns false, loop continues
 *   - happy path: 3 projects, 2 eligible → enableForProject called exactly twice
 *   - per-project failure isolation (project 2 throws, 1 and 3 still attempted)
 *   - setMainWindowGetter called with the EXACT passed getter (reference identity)
 *   - case-insensitive: both "true" and "TRUE" recognized
 *
 * Mocks: service singleton, projectStore, getGitHubTokenForSubprocess, fs.
 * parseEnvFile (pure function in ../ipc-handlers/utils) is used unmocked;
 * it's fed from our mocked fs.readFileSync so the full parse → flag-check
 * path is exercised end-to-end. Mock vars declared OUTSIDE vi.mock()
 * factories per Vitest hoisting rules.
 *
 * Mirrors the structure of pr-status-poller.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { Project } from '../../../shared/types';

// ---------------------------------------------------------------------------
// Mocks — mock vars declared OUTSIDE vi.mock() factories.
// Vitest hoists vi.mock() above top-level imports, so factories must refer
// to outer vars lazily (through arrow wrappers).
// ---------------------------------------------------------------------------

const mockSetMainWindowGetter = vi.fn();
const mockEnableForProject = vi.fn();
const mockGetInstance = vi.fn(() => ({
  setMainWindowGetter: mockSetMainWindowGetter,
  enableForProject: mockEnableForProject,
}));

vi.mock('../auto-pr-review-service', () => ({
  AutoPRReviewService: {
    getInstance: () => mockGetInstance(),
  },
}));

const mockGetProjects = vi.fn();
vi.mock('../../project-store', () => ({
  projectStore: {
    getProjects: () => mockGetProjects(),
  },
}));

const mockGetGitHubTokenForSubprocess = vi.fn();
vi.mock('../../ipc-handlers/github/utils', () => ({
  getGitHubTokenForSubprocess: () => mockGetGitHubTokenForSubprocess(),
}));

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks are registered
// ---------------------------------------------------------------------------

import {
  enableAutoPRReviewForProject,
  restoreAutoPRReviewOnStartup,
} from '../auto-pr-review-helpers';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal Project fixture — only fields the helpers touch. */
function makeProject(id = 'p1', overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    autoBuildPath: '.auto-claude',
    settings: {
      model: 'sonnet',
      memoryBackend: 'file',
      linearSync: false,
      graphitiMcpEnabled: false,
      notifications: {
        onTaskComplete: true,
        onTaskFailed: true,
        onReviewNeeded: true,
        onPRReviewComplete: true,
        onClaudeSessionComplete: true,
        sound: false,
      },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Fake main window; nothing inside the helpers dereferences it. */
const mockMainWindow = {
  webContents: { send: vi.fn() },
};
const makeGetter = () =>
  vi.fn(() => mockMainWindow as unknown as BrowserWindow);

// ---------------------------------------------------------------------------

describe('auto-pr-review-helpers', () => {
  beforeEach(() => {
    // Clear call history; preserve factory implementations.
    mockSetMainWindowGetter.mockReset();
    mockEnableForProject.mockReset();
    mockGetInstance.mockClear();
    mockGetProjects.mockReset();
    mockGetGitHubTokenForSubprocess.mockReset();
    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();

    // Silence helper's [AutoPRReview] warn/info output by default —
    // individual tests spy again when they need to assert log content.
    // biome-ignore lint/suspicious/noEmptyBlockStatements: mock implementation intentionally empty
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // biome-ignore lint/suspicious/noEmptyBlockStatements: mock implementation intentionally empty
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // enableAutoPRReviewForProject
  // =========================================================================
  describe('enableAutoPRReviewForProject', () => {
    it('happy path with override repo: setMainWindowGetter called BEFORE enableForProject; returns true', async () => {
      mockGetGitHubTokenForSubprocess.mockResolvedValue('test-token');
      const project = makeProject('p1');
      const getter = makeGetter();

      const result = await enableAutoPRReviewForProject(
        project,
        getter,
        'owner/repo'
      );

      expect(result).toBe(true);

      // Order: setMainWindowGetter before enableForProject.
      const setGetterOrder =
        mockSetMainWindowGetter.mock.invocationCallOrder[0];
      const enableOrder = mockEnableForProject.mock.invocationCallOrder[0];
      expect(setGetterOrder).toBeDefined();
      expect(enableOrder).toBeDefined();
      expect(setGetterOrder).toBeLessThan(enableOrder);

      // Getter passed through exactly once, with identity preserved.
      expect(mockSetMainWindowGetter).toHaveBeenCalledTimes(1);
      expect(mockSetMainWindowGetter).toHaveBeenCalledWith(getter);

      // enableForProject called with (id, project, {token, repo}).
      expect(mockEnableForProject).toHaveBeenCalledTimes(1);
      expect(mockEnableForProject).toHaveBeenCalledWith('p1', project, {
        token: 'test-token',
        repo: 'owner/repo',
      });

      // Override truthy → || short-circuits → readFileSync never invoked.
      expect(mockReadFileSync).not.toHaveBeenCalled();
    });

    it('falls back to .env GITHUB_REPO when override is absent', async () => {
      mockGetGitHubTokenForSubprocess.mockResolvedValue('test-token');
      mockReadFileSync.mockReturnValue('GITHUB_REPO=env-owner/env-repo\n');

      const project = makeProject('p1');
      const getter = makeGetter();

      const result = await enableAutoPRReviewForProject(project, getter);

      expect(result).toBe(true);
      expect(mockReadFileSync).toHaveBeenCalled();
      expect(mockEnableForProject).toHaveBeenCalledWith('p1', project, {
        token: 'test-token',
        repo: 'env-owner/env-repo',
      });
    });

    it('empty-string override falls through to .env (|| semantics, not ??)', async () => {
      mockGetGitHubTokenForSubprocess.mockResolvedValue('test-token');
      mockReadFileSync.mockReturnValue('GITHUB_REPO=env-owner/env-repo\n');

      const project = makeProject('p1');
      const getter = makeGetter();

      const result = await enableAutoPRReviewForProject(project, getter, '');

      expect(result).toBe(true);
      expect(mockReadFileSync).toHaveBeenCalled();
      expect(mockEnableForProject).toHaveBeenCalledWith('p1', project, {
        token: 'test-token',
        repo: 'env-owner/env-repo',
      });
    });

    it('returns false when token is null; service not invoked', async () => {
      mockGetGitHubTokenForSubprocess.mockResolvedValue(null);

      const project = makeProject('p1');
      const getter = makeGetter();

      const result = await enableAutoPRReviewForProject(
        project,
        getter,
        'owner/repo'
      );

      expect(result).toBe(false);
      expect(mockSetMainWindowGetter).not.toHaveBeenCalled();
      expect(mockEnableForProject).not.toHaveBeenCalled();
    });

    it('returns false when repo is missing from both override and .env', async () => {
      mockGetGitHubTokenForSubprocess.mockResolvedValue('test-token');
      // .env exists but has no GITHUB_REPO key.
      mockReadFileSync.mockReturnValue('SOME_OTHER_KEY=value\n');

      const project = makeProject('p1');
      const getter = makeGetter();

      const result = await enableAutoPRReviewForProject(project, getter);

      expect(result).toBe(false);
      expect(mockSetMainWindowGetter).not.toHaveBeenCalled();
      expect(mockEnableForProject).not.toHaveBeenCalled();
    });

    it('swallows errors from getGitHubTokenForSubprocess: does not throw, returns false, logs [AutoPRReview] warning', async () => {
      const warnSpy = vi
        .spyOn(console, 'warn')
        // biome-ignore lint/suspicious/noEmptyBlockStatements: mock implementation intentionally empty
        .mockImplementation(() => {});
      mockGetGitHubTokenForSubprocess.mockRejectedValue(new Error('boom'));

      const project = makeProject('p1');
      const getter = makeGetter();

      await expect(
        enableAutoPRReviewForProject(project, getter, 'owner/repo')
      ).resolves.toBe(false);

      expect(mockEnableForProject).not.toHaveBeenCalled();

      // At least one warn call includes the [AutoPRReview] prefix.
      const prefixed = warnSpy.mock.calls.some((call) =>
        call.some(
          (arg) => typeof arg === 'string' && arg.includes('[AutoPRReview]')
        )
      );
      expect(prefixed).toBe(true);
    });
  });

  // =========================================================================
  // restoreAutoPRReviewOnStartup
  // =========================================================================
  describe('restoreAutoPRReviewOnStartup', () => {
    it('empty project list → no-op; logs "Restored 0 of 0"', async () => {
      const infoSpy = vi
        .spyOn(console, 'info')
        // biome-ignore lint/suspicious/noEmptyBlockStatements: mock implementation intentionally empty
        .mockImplementation(() => {});
      mockGetProjects.mockReturnValue([]);

      await restoreAutoPRReviewOnStartup(makeGetter());

      expect(mockEnableForProject).not.toHaveBeenCalled();
      expect(mockReadFileSync).not.toHaveBeenCalled();
      expect(mockExistsSync).not.toHaveBeenCalled();

      const loggedSummary = infoSpy.mock.calls.some((call) =>
        call.some(
          (arg) => typeof arg === 'string' && arg.includes('Restored 0 of 0')
        )
      );
      expect(loggedSummary).toBe(true);
    });

    it('project without autoBuildPath → skipped (no readFileSync call for it)', async () => {
      mockGetProjects.mockReturnValue([
        // Intentionally falsy autoBuildPath — legacy/corrupt store data
        // may still produce this at runtime (spec edge case 1).
        makeProject('p1', { autoBuildPath: '' as unknown as string }),
      ]);

      await restoreAutoPRReviewOnStartup(makeGetter());

      expect(mockReadFileSync).not.toHaveBeenCalled();
      expect(mockExistsSync).not.toHaveBeenCalled();
      expect(mockEnableForProject).not.toHaveBeenCalled();
    });

    it('project where .env does not exist → skipped', async () => {
      mockGetProjects.mockReturnValue([makeProject('p1')]);
      mockExistsSync.mockReturnValue(false);

      await restoreAutoPRReviewOnStartup(makeGetter());

      expect(mockExistsSync).toHaveBeenCalled();
      expect(mockReadFileSync).not.toHaveBeenCalled();
      expect(mockEnableForProject).not.toHaveBeenCalled();
    });

    it('.env missing GITHUB_AUTO_PR_REVIEW key → skipped', async () => {
      mockGetProjects.mockReturnValue([makeProject('p1')]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('SOME_OTHER_KEY=value\n');

      await restoreAutoPRReviewOnStartup(makeGetter());

      expect(mockEnableForProject).not.toHaveBeenCalled();
      // getGitHubTokenForSubprocess must NOT have been called — the skip
      // happened before the helper was invoked.
      expect(mockGetGitHubTokenForSubprocess).not.toHaveBeenCalled();
    });

    it('GITHUB_AUTO_PR_REVIEW=false → skipped', async () => {
      mockGetProjects.mockReturnValue([makeProject('p1')]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('GITHUB_AUTO_PR_REVIEW=false\n');

      await restoreAutoPRReviewOnStartup(makeGetter());

      expect(mockEnableForProject).not.toHaveBeenCalled();
      expect(mockGetGitHubTokenForSubprocess).not.toHaveBeenCalled();
    });

    it('flag true but GITHUB_REPO missing → helper invoked, returns false, no crash, loop continues', async () => {
      const p1 = makeProject('p1');
      const p2 = makeProject('p2');
      mockGetProjects.mockReturnValue([p1, p2]);
      mockExistsSync.mockReturnValue(true);
      // Both projects: flag on, no GITHUB_REPO.
      mockReadFileSync.mockReturnValue('GITHUB_AUTO_PR_REVIEW=true\n');
      mockGetGitHubTokenForSubprocess.mockResolvedValue('tok');

      // Must not throw — loop swallows per-project failure.
      await expect(
        restoreAutoPRReviewOnStartup(makeGetter())
      ).resolves.toBeUndefined();

      // Helper was invoked but short-circuited on missing repo → service
      // enableForProject never called.
      expect(mockEnableForProject).not.toHaveBeenCalled();
      // Token resolver was invoked once per project (loop continued).
      expect(mockGetGitHubTokenForSubprocess).toHaveBeenCalledTimes(2);
    });

    it('happy path: 3 projects where 2 are eligible → enableForProject called exactly twice', async () => {
      const infoSpy = vi
        .spyOn(console, 'info')
        // biome-ignore lint/suspicious/noEmptyBlockStatements: mock implementation intentionally empty
        .mockImplementation(() => {});

      const p1 = makeProject('p1');
      const p2 = makeProject('p2');
      const p3 = makeProject('p3');
      mockGetProjects.mockReturnValue([p1, p2, p3]);
      mockExistsSync.mockReturnValue(true);

      // Per-path content: p1 & p3 eligible; p2 ineligible (flag false).
      mockReadFileSync.mockImplementation((p: unknown) => {
        const envPath = String(p);
        if (envPath.includes('p1')) {
          return 'GITHUB_AUTO_PR_REVIEW=true\nGITHUB_REPO=owner/p1\n';
        }
        if (envPath.includes('p2')) {
          return 'GITHUB_AUTO_PR_REVIEW=false\n';
        }
        if (envPath.includes('p3')) {
          return 'GITHUB_AUTO_PR_REVIEW=true\nGITHUB_REPO=owner/p3\n';
        }
        return '';
      });

      mockGetGitHubTokenForSubprocess.mockResolvedValue('tok');

      await restoreAutoPRReviewOnStartup(makeGetter());

      expect(mockEnableForProject).toHaveBeenCalledTimes(2);
      expect(mockEnableForProject).toHaveBeenCalledWith('p1', p1, {
        token: 'tok',
        repo: 'owner/p1',
      });
      expect(mockEnableForProject).toHaveBeenCalledWith('p3', p3, {
        token: 'tok',
        repo: 'owner/p3',
      });

      // Summary log reflects 2 of 3.
      const loggedSummary = infoSpy.mock.calls.some((call) =>
        call.some(
          (arg) => typeof arg === 'string' && arg.includes('Restored 2 of 3')
        )
      );
      expect(loggedSummary).toBe(true);
    });

    it('per-project failure isolation: project 2 throws during read; projects 1 and 3 still attempted', async () => {
      const warnSpy = vi
        .spyOn(console, 'warn')
        // biome-ignore lint/suspicious/noEmptyBlockStatements: mock implementation intentionally empty
        .mockImplementation(() => {});

      const p1 = makeProject('p1');
      const p2 = makeProject('p2');
      const p3 = makeProject('p3');
      mockGetProjects.mockReturnValue([p1, p2, p3]);
      mockExistsSync.mockReturnValue(true);

      mockReadFileSync.mockImplementation((p: unknown) => {
        const envPath = String(p);
        if (envPath.includes('p2')) {
          throw new Error('corrupt .env');
        }
        if (envPath.includes('p1')) {
          return 'GITHUB_AUTO_PR_REVIEW=true\nGITHUB_REPO=owner/p1\n';
        }
        if (envPath.includes('p3')) {
          return 'GITHUB_AUTO_PR_REVIEW=true\nGITHUB_REPO=owner/p3\n';
        }
        return '';
      });

      mockGetGitHubTokenForSubprocess.mockResolvedValue('tok');

      await restoreAutoPRReviewOnStartup(makeGetter());

      // p1 and p3 enabled; p2 failed silently.
      expect(mockEnableForProject).toHaveBeenCalledTimes(2);
      const enabledIds = mockEnableForProject.mock.calls.map((c) => c[0]);
      expect(enabledIds).toContain('p1');
      expect(enabledIds).toContain('p3');
      expect(enabledIds).not.toContain('p2');

      // A [AutoPRReview] warning mentioning p2 was logged.
      const hasP2Warning = warnSpy.mock.calls.some((call) =>
        call.some(
          (arg) =>
            typeof arg === 'string' &&
            arg.includes('[AutoPRReview]') &&
            arg.includes('p2')
        )
      );
      expect(hasP2Warning).toBe(true);
    });

    it('setMainWindowGetter called with the EXACT passed getter (identity check, not wrapped)', async () => {
      mockGetProjects.mockReturnValue([makeProject('p1')]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        'GITHUB_AUTO_PR_REVIEW=true\nGITHUB_REPO=owner/p1\n'
      );
      mockGetGitHubTokenForSubprocess.mockResolvedValue('tok');

      const getter = makeGetter();
      await restoreAutoPRReviewOnStartup(getter);

      // Exactly one call (single eligible project), and the argument is the
      // SAME function reference the caller passed in — not a wrapper like
      // () => getter(). This guards against subtle regressions where a
      // refactor accidentally wraps the getter.
      expect(mockSetMainWindowGetter).toHaveBeenCalledTimes(1);
      expect(mockSetMainWindowGetter.mock.calls[0][0]).toBe(getter);
    });

    it('case-insensitive: lowercase "true" is recognized', async () => {
      mockGetProjects.mockReturnValue([makeProject('p1')]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        'GITHUB_AUTO_PR_REVIEW=true\nGITHUB_REPO=owner/p1\n'
      );
      mockGetGitHubTokenForSubprocess.mockResolvedValue('tok');

      await restoreAutoPRReviewOnStartup(makeGetter());

      expect(mockEnableForProject).toHaveBeenCalledTimes(1);
    });

    it('case-insensitive: uppercase "TRUE" is recognized', async () => {
      mockGetProjects.mockReturnValue([makeProject('p1')]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        'GITHUB_AUTO_PR_REVIEW=TRUE\nGITHUB_REPO=owner/p1\n'
      );
      mockGetGitHubTokenForSubprocess.mockResolvedValue('tok');

      await restoreAutoPRReviewOnStartup(makeGetter());

      expect(mockEnableForProject).toHaveBeenCalledTimes(1);
    });
  });
});
