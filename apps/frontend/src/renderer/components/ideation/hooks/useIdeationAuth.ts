import { useState, useEffect } from 'react';
import { useSettingsStore } from '../../../stores/settings-store';

/**
 * Hook to check if the ideation feature has valid authentication.
 * This combines three sources of authentication:
 * 1. OAuth token from source .env (checked via checkSourceToken)
 * 2. Active API profile (custom Anthropic-compatible endpoint)
 * 3. Authenticated Claude Code OAuth profile (Keychain-based auth)
 *
 * @returns { hasToken, isLoading, error, checkAuth }
 * - hasToken: true if any valid auth source exists
 * - isLoading: true while checking authentication status
 * - error: any error that occurred during auth check
 * - checkAuth: function to manually re-check authentication status
 */
export function useIdeationAuth() {
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Get active API profile info from settings store
  const activeProfileId = useSettingsStore((state) => state.activeProfileId);

  const resolveHasAPIProfile = async (profileId?: string | null): Promise<boolean> => {
    // Trust the store when it's already populated to avoid extra IPC calls; fallback to IPC only when empty.
    if (profileId && profileId !== '') {
      return true;
    }

    try {
      const profilesResult = await window.electronAPI.getAPIProfiles();
      return Boolean(
        profilesResult.success &&
        profilesResult.data?.activeProfileId &&
        profilesResult.data.activeProfileId !== ''
      );
    } catch {
      return false;
    }
  };

  const resolveHasAuthenticatedOAuthProfile = async (): Promise<boolean> => {
    try {
      const result = await window.electronAPI.getClaudeProfiles();
      if (result.success && result.data?.profiles) {
        return result.data.profiles.some(p => p.isAuthenticated);
      }
    } catch {
      // Fall through
    }
    return false;
  };

  const performAuthCheck = async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Check all three auth sources in parallel
      const [sourceTokenResult, hasAPIProfile, hasOAuthProfile] = await Promise.all([
        window.electronAPI.checkSourceToken(),
        resolveHasAPIProfile(activeProfileId),
        resolveHasAuthenticatedOAuthProfile()
      ]);

      const hasSourceOAuthToken = sourceTokenResult.success && sourceTokenResult.data?.hasToken;

      // Auth is valid if any source is available
      setHasToken(Boolean(hasSourceOAuthToken || hasAPIProfile || hasOAuthProfile));
    } catch (err) {
      setHasToken(false);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    performAuthCheck();
  }, [activeProfileId]);

  return { hasToken, isLoading, error, checkAuth: performAuthCheck };
}
