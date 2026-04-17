/**
 * Auto PR Review Service Helpers
 *
 * Shared helpers for enabling the AutoPRReviewService. Used by both the
 * ENV_UPDATE IPC handler (user toggle) and the app-startup restore hook
 * so the two code paths stay in lockstep.
 *
 * @module auto-pr-review-helpers
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import type { BrowserWindow } from 'electron';
import type { Project } from '../../shared/types';
import { parseEnvFile } from '../ipc-handlers/utils';
import { getGitHubTokenForSubprocess } from '../ipc-handlers/github/utils';
import { projectStore } from '../project-store';
import { AutoPRReviewService } from './auto-pr-review-service';

/**
 * Enable AutoPRReviewService polling for a single project.
 *
 * Resolves a fresh GitHub token, determines the repo (override first, then
 * `.env` fallback), and starts the 5-minute polling timer via
 * `AutoPRReviewService.enableForProject`. All errors are swallowed to keep
 * the caller (IPC handler or startup loop) from crashing.
 *
 * Mirrors the inline enable block formerly at `env-handlers.ts:653-666`.
 *
 * @param project - The project to enable polling for.
 * @param getMainWindow - Getter returning the current BrowserWindow (may be null).
 * @param githubRepoOverride - Optional explicit "owner/repo" override. When
 *   falsy (empty string or undefined), the helper falls back to
 *   `GITHUB_REPO` parsed from the project's `.env`. NOTE: we use `||` not
 *   `??` to preserve the existing behavior at `env-handlers.ts:658` —
 *   empty strings must fall through to the `.env` lookup.
 * @returns `true` if polling was started, `false` on any skip/failure.
 */
export async function enableAutoPRReviewForProject(
  project: Project,
  getMainWindow: () => BrowserWindow | null,
  githubRepoOverride?: string
): Promise<boolean> {
  try {
    const token = await getGitHubTokenForSubprocess();

    // IMPORTANT: use `||` (logical OR, falsy fallback) — NOT `??` — to
    // match the existing behavior at env-handlers.ts:658. An empty-string
    // override must fall through to the `.env` value.
    const envPath = path.join(project.path, project.autoBuildPath, '.env');
    const repo =
      githubRepoOverride ||
      parseEnvFile(readFileSync(envPath, 'utf-8'))['GITHUB_REPO'];

    if (!token || !repo) {
      return false;
    }

    const svc = AutoPRReviewService.getInstance();
    // Order matters: setMainWindowGetter MUST be called before
    // enableForProject so the service has the getter when it kicks off its
    // immediate first poll inside enableForProject.
    svc.setMainWindowGetter(getMainWindow);
    svc.enableForProject(project.id, project, { token, repo });
    return true;
  } catch (err) {
    console.warn('[AutoPRReview] Failed to enable auto PR review:', err);
    return false;
  }
}

/**
 * Restore AutoPRReviewService polling on app startup.
 *
 * Iterates every known project; for any whose `.env` contains
 * `GITHUB_AUTO_PR_REVIEW=true` (case-insensitive), re-enables the 5-minute
 * polling without user interaction. Per-project failures never abort the
 * loop — they are logged and iteration continues.
 *
 * Emits a `[AutoPRReview] Restored N of M projects` summary when done.
 *
 * @param getMainWindow - Getter returning the current BrowserWindow.
 */
export async function restoreAutoPRReviewOnStartup(
  getMainWindow: () => BrowserWindow | null
): Promise<void> {
  const projects = projectStore.getProjects();
  let restoredCount = 0;

  for (const project of projects) {
    try {
      // Defensive: legacy / corrupt store data may have a falsy
      // autoBuildPath at runtime even though the type declares it
      // required. Same guard as env-handlers.ts:627 and
      // github/utils.ts:200.
      if (!project.autoBuildPath) continue;

      const envPath = path.join(project.path, project.autoBuildPath, '.env');
      if (!existsSync(envPath)) continue;

      const content = readFileSync(envPath, 'utf-8');
      const vars = parseEnvFile(content);

      // Case-insensitive flag check — matches env-handlers.ts:460.
      const enabled =
        vars['GITHUB_AUTO_PR_REVIEW']?.toLowerCase() === 'true';
      if (!enabled) continue;

      const ok = await enableAutoPRReviewForProject(project, getMainWindow);
      if (ok) restoredCount += 1;
    } catch (err) {
      console.warn(
        `[AutoPRReview] Failed to restore project ${project.id}:`,
        err
      );
    }
  }

  console.info(
    `[AutoPRReview] Restored ${restoredCount} of ${projects.length} projects`
  );
}
