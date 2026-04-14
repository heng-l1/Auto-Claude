import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, X } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { useSettingsStore, saveSettings } from "../stores/settings-store";
import type { AppUpdateAvailableEvent } from "../../shared/types";

// Poll for updates every 5 minutes
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

const GITHUB_RELEASES_URL = "https://github.com/heng-l1/Auto-Claude/releases";

interface UpdateBannerProps {
  className?: string;
}

/**
 * Inline update notification banner for the sidebar.
 * Shows when a new application update is available and directs
 * users to the GitHub releases page.
 */
export function UpdateBanner({ className }: UpdateBannerProps) {
  const { t } = useTranslation(["navigation", "common"]);
  const settings = useSettingsStore((state) => state.settings);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateAvailableEvent | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);

  // Ref to track current version for stable callbacks
  const currentVersionRef = useRef<string | null>(null);

  // Check for updates
  const checkForUpdate = useCallback(async () => {
    try {
      const result = await window.electronAPI.checkAppUpdate();
      if (result.success && result.data) {
        const newVersion = result.data.version;
        // New update available - show banner (unless same version already dismissed)
        if (currentVersionRef.current !== newVersion) {
          setIsDismissed(false);
          currentVersionRef.current = newVersion;
        }
        // Auto-clear skipped version when a different version is detected
        const skippedVersion = useSettingsStore.getState().settings.skippedUpdateVersion;
        if (skippedVersion && skippedVersion !== newVersion) {
          saveSettings({ skippedUpdateVersion: undefined });
        }
        setUpdateInfo({
          version: newVersion,
          releaseNotes: result.data.releaseNotes,
          releaseDate: result.data.releaseDate,
        });
      }
    } catch (_err) {
      // Silent failure - update check is non-critical
    }
  }, []);

  // Initial check and periodic polling
  useEffect(() => {
    checkForUpdate();

    const interval = setInterval(() => {
      checkForUpdate();
    }, UPDATE_CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [checkForUpdate]);

  // Listen for push notifications about updates
  useEffect(() => {
    const cleanup = window.electronAPI.onAppUpdateAvailable((info) => {
      // New update notification - reset dismiss state if new version
      if (currentVersionRef.current !== info.version) {
        setIsDismissed(false);
        currentVersionRef.current = info.version;
      }
      // Auto-clear skipped version when a different version is detected
      const skippedVersion = useSettingsStore.getState().settings.skippedUpdateVersion;
      if (skippedVersion && skippedVersion !== info.version) {
        saveSettings({ skippedUpdateVersion: undefined });
      }
      setUpdateInfo(info);
    });

    return cleanup;
  }, []);

  // Handle view on GitHub
  const handleViewOnGitHub = () => {
    const url = updateInfo?.version
      ? `${GITHUB_RELEASES_URL}/tag/v${updateInfo.version}`
      : GITHUB_RELEASES_URL;
    window.electronAPI.openExternal(url);
  };

  // Handle dismiss
  const handleDismiss = () => {
    setIsDismissed(true);
  };

  // Handle skip this version
  const handleSkipVersion = () => {
    setIsDismissed(true);
    if (updateInfo) {
      saveSettings({ skippedUpdateVersion: updateInfo.version });
    }
  };

  // Don't render if no update, dismissed, or user skipped this version
  if (!updateInfo || isDismissed || settings.skippedUpdateVersion === updateInfo.version) {
    return null;
  }

  return (
    <div
      className={cn(
        "mx-3 mb-3 rounded-lg border border-info/30 bg-info/10 p-3",
        className
      )}
    >
      {/* Header with version and dismiss */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <ExternalLink className="h-4 w-4 text-info shrink-0" />
          <span className="text-xs font-medium text-foreground">
            {t("navigation:updateBanner.title")}
          </span>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label={t("navigation:updateBanner.dismiss")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Version info */}
      <p className="text-xs text-muted-foreground mb-3">
        {t("navigation:updateBanner.version", { version: updateInfo.version })}
      </p>

      {/* Action buttons */}
      <div className="flex gap-2">
        <Button
          size="sm"
          className="flex-1 h-7 text-xs gap-1.5"
          onClick={handleViewOnGitHub}
        >
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
          {t("navigation:updateBanner.viewOnGitHub")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={handleSkipVersion}
        >
          {t("navigation:updateBanner.skipVersion")}
        </Button>
      </div>
    </div>
  );
}
