import { buildAugmentedPythonEnv, getOAuthModeClearVars } from '../../../agent/env-utils';
import { getAPIProfileEnv } from '../../../services/profile';
import { getBestAvailableProfileEnv } from '../../../rate-limit-detector';
import { pythonEnvManager } from '../../../python-env-manager';
import { getGitHubTokenForSubprocess } from '../utils';
import { safeBreadcrumb } from '../../../sentry';
import { getToolInfo } from '../../../cli-tool-manager';

/**
 * Get environment variables for Python runner subprocesses.
 *
 * Environment variable precedence (lowest to highest):
 * 1. augmented - Login-shell PATH + Sentry env (via buildAugmentedPythonEnv → getAugmentedEnv)
 * 2. mergedPythonEnv - Python environment including PYTHONPATH for bundled packages (fixes #139), with PATH merged against augmented
 * 3. apiProfileEnv - Custom Anthropic-compatible API profile (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN)
 * 4. oauthModeClearVars - Clears stale ANTHROPIC_* vars when in OAuth mode
 * 5. profileEnv - Claude OAuth token from profile manager (CLAUDE_CODE_OAUTH_TOKEN)
 * 6. githubEnv - Fresh GitHub token from gh CLI (GITHUB_TOKEN) - fetched on each call to reflect account changes
 * 7. ghCliEnv - gh CLI path for bundled apps (Python backend uses GITHUB_CLI_PATH)
 * 8. extraEnv - Caller-specific vars (e.g., USE_CLAUDE_MD)
 *
 * NOTE: extraEnv can intentionally override any of the above, including GITHUB_TOKEN.
 * This allows callers to provide their own token for testing or special cases.
 *
 * The augmented env is critical for GUI-launched builds where the child would otherwise
 * inherit a stripped PATH; it injects common tool locations so locally-installed CLI
 * tools remain discoverable.
 *
 * The pythonEnv is critical for packaged apps (#139) - without PYTHONPATH, Python
 * cannot find bundled dependencies like dotenv, claude_agent_sdk, etc.
 *
 * The profileEnv is critical for OAuth authentication (#563) - it retrieves the
 * decrypted OAuth token from the profile manager's encrypted storage (macOS Keychain
 * via Electron's safeStorage API).
 *
 * The githubEnv is critical for GitHub operations (#151) - it fetches a fresh token
 * from the gh CLI on each call to ensure account changes are reflected immediately.
 */
export async function getRunnerEnv(
  extraEnv?: Record<string, string>
): Promise<Record<string, string>> {
  const pythonEnv = pythonEnvManager.getPythonEnv();
  const apiProfileEnv = await getAPIProfileEnv();
  const oauthModeClearVars = getOAuthModeClearVars(apiProfileEnv);
  // Get best available Claude profile environment (automatically handles rate limits)
  const profileResult = getBestAvailableProfileEnv();
  const profileEnv = profileResult.env;

  // Fetch fresh GitHub token from gh CLI (no caching to reflect account changes)
  const githubToken = await getGitHubTokenForSubprocess();
  const githubEnv: Record<string, string> = githubToken ? { GITHUB_TOKEN: githubToken } : {};

  // Resolve gh CLI path so Python subprocess can find it in bundled apps
  // (bundled Electron apps have a stripped PATH that doesn't include Homebrew etc.)
  const ghInfo = getToolInfo('gh');
  const ghCliEnv: Record<string, string> = ghInfo.found && ghInfo.path ? { GITHUB_CLI_PATH: ghInfo.path } : {};
  safeBreadcrumb({
    category: 'github.runner-env',
    message: `gh CLI for subprocess: found=${ghInfo.found}, path=${ghInfo.path ?? 'none'}, source=${ghInfo.source ?? 'none'}`,
    level: ghInfo.found ? 'info' : 'warning',
    data: {
      found: ghInfo.found,
      path: ghInfo.path ?? null,
      source: ghInfo.source ?? null,
      willSetGITHUB_CLI_PATH: !!(ghInfo.found && ghInfo.path),
      hasGITHUB_TOKEN: !!githubToken,
    },
  });

  // Compose the augmented base env (login-shell PATH + Sentry env) with the Python
  // overlay so locally-installed CLI tools are discoverable in GUI-launched builds.
  const { env: augmented, mergedPythonEnv } = buildAugmentedPythonEnv(pythonEnv);

  return {
    ...augmented,  // Login-shell PATH + Sentry env (Sentry is injected inside getAugmentedEnv)
    ...mergedPythonEnv,  // Python environment including PYTHONPATH (fixes #139) with merged PATH
    ...apiProfileEnv,
    ...oauthModeClearVars,
    ...profileEnv,  // OAuth token from profile manager (fixes #563, rate-limit aware)
    ...githubEnv,  // Fresh GitHub token from gh CLI (fixes #151)
    ...ghCliEnv,  // gh CLI path for bundled apps (Python backend uses GITHUB_CLI_PATH)
    ...extraEnv,  // extraEnv last so callers can still override
  };
}
