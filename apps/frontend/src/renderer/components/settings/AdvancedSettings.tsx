import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RefreshCw,
  CheckCircle2,
  Sparkles,
  ArrowDownToLine,
  X,
  ExternalLink
} from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { SettingsSection } from './SettingsSection';
import type {
  AppSettings,
  AppUpdateAvailableEvent,
  AppUpdateInfo,
  NotificationSettings
} from '../../../shared/types';

const GITHUB_RELEASES_URL = 'https://github.com/heng-l1/Auto-Claude/releases';

/**
 * Release notes renderer that handles both HTML and markdown input.
 * GitHub release notes come as HTML, so we detect and handle both formats.
 * Uses ReactMarkdown with rehype-sanitize to prevent XSS attacks.
 */
/** Safe link component that opens external URLs in the default browser */
const safeMarkdownComponents: Components = {
  a: ({ href, children, ...props }) => {
    const isExternal = href?.startsWith('http://') || href?.startsWith('https://');
    return (
      <a
        href={href}
        {...props}
        {...(isExternal && { target: '_blank', rel: 'noopener noreferrer' })}
        className="text-primary hover:underline"
      >
        {children}
      </a>
    );
  }
};

function ReleaseNotesRenderer({ content }: { content: string }) {
  return (
    <div className="text-sm text-muted-foreground leading-relaxed prose prose-sm dark:prose-invert max-w-none [&_ul]:ml-4 [&_ol]:ml-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={safeMarkdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

interface AdvancedSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  section: 'updates' | 'notifications';
  version: string;
}

/**
 * Advanced settings for updates and notifications
 */
export function AdvancedSettings({ settings, onSettingsChange, section, version }: AdvancedSettingsProps) {
  const { t } = useTranslation('settings');

  // Electron app update state
  const [appUpdateInfo, setAppUpdateInfo] = useState<AppUpdateAvailableEvent | null>(null);
  const [isCheckingAppUpdate, setIsCheckingAppUpdate] = useState(false);
  // Stable downgrade state (shown when user turns off beta while on prerelease)
  const [stableDowngradeInfo, setStableDowngradeInfo] = useState<AppUpdateInfo | null>(null);

  // Check for updates on mount
  useEffect(() => {
    if (section !== 'updates') {
      return;
    }

    let isCancelled = false;

    (async () => {
      setIsCheckingAppUpdate(true);
      try {
        const result = await window.electronAPI.checkAppUpdate();
        if (isCancelled) return;
        if (result.success && result.data) {
          setAppUpdateInfo(result.data);
        } else {
          setAppUpdateInfo(null);
        }
      } catch (err) {
        console.error('Failed to check for app updates:', err);
      } finally {
        if (!isCancelled) {
          setIsCheckingAppUpdate(false);
        }
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [section]);

  // Listen for app update events
  useEffect(() => {
    const cleanupAvailable = window.electronAPI.onAppUpdateAvailable((info) => {
      setAppUpdateInfo(info);
      setIsCheckingAppUpdate(false);
    });

    // Listen for stable downgrade available (when user turns off beta while on prerelease)
    const cleanupStableDowngrade = window.electronAPI.onAppUpdateStableDowngrade((info) => {
      setStableDowngradeInfo(info);
    });

    return () => {
      cleanupAvailable();
      cleanupStableDowngrade();
    };
  }, []);

  const checkForAppUpdates = async () => {
    setIsCheckingAppUpdate(true);
    try {
      const result = await window.electronAPI.checkAppUpdate();
      if (result.success && result.data) {
        setAppUpdateInfo(result.data);
      } else {
        // No update available
        setAppUpdateInfo(null);
      }
    } catch (err) {
      console.error('Failed to check for app updates:', err);
    } finally {
      setIsCheckingAppUpdate(false);
    }
  };

  const dismissStableDowngrade = () => {
    setStableDowngradeInfo(null);
  };

  if (section === 'updates') {
    return (
      <SettingsSection
        title={t('updates.title')}
        description={t('updates.description')}
      >
        <div className="space-y-6">
          {/* Current Version Display */}
          <div className="rounded-lg border border-border bg-muted/50 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{t('updates.version')}</p>
                <p className="text-base font-medium text-foreground">
                  {version || t('updates.loading')}
                </p>
              </div>
              {isCheckingAppUpdate ? (
                <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
              ) : appUpdateInfo ? (
                <ExternalLink className="h-6 w-6 text-info" />
              ) : (
                <CheckCircle2 className="h-6 w-6 text-success" />
              )}
            </div>

            {/* Update status */}
            {!appUpdateInfo && !isCheckingAppUpdate && (
              <p className="text-sm text-muted-foreground">
                {t('updates.latestVersion')}
              </p>
            )}

            <div className="pt-2">
              <Button
                size="sm"
                variant="outline"
                onClick={checkForAppUpdates}
                disabled={isCheckingAppUpdate}
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${isCheckingAppUpdate ? 'animate-spin' : ''}`} />
                {t('updates.checkForUpdates')}
              </Button>
            </div>
          </div>

          {/* Electron App Update Section - shows when update available */}
          {appUpdateInfo && (
            <div className="rounded-lg border-2 border-info/50 bg-info/5 p-5 space-y-4">
              <div className="flex items-center gap-2 text-info">
                <Sparkles className="h-5 w-5" />
                <h3 className="font-semibold">{t('updates.appUpdateReady')}</h3>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
                    {t('updates.newVersion')}
                  </p>
                  <p className="text-base font-medium text-foreground">
                    {appUpdateInfo.version || 'Unknown'}
                  </p>
                  {appUpdateInfo.releaseDate && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('updates.released')} {new Date(appUpdateInfo.releaseDate).toLocaleDateString()}
                    </p>
                  )}
                </div>
                <ExternalLink className="h-6 w-6 text-info" />
              </div>

              {/* Release Notes */}
              {appUpdateInfo.releaseNotes && (
                <div className="bg-background rounded-lg p-4 max-h-48 overflow-y-auto border border-border/50">
                  <ReleaseNotesRenderer content={appUpdateInfo.releaseNotes} />
                </div>
              )}

              {/* View on GitHub Button */}
              <div className="flex gap-3">
                <Button
                  onClick={() => {
                    const url = appUpdateInfo?.version
                      ? `${GITHUB_RELEASES_URL}/tag/v${appUpdateInfo.version}`
                      : GITHUB_RELEASES_URL;
                    window.electronAPI.openExternal(url);
                  }}
                >
                  <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('updates.viewOnGitHub')}
                </Button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between p-4 rounded-lg border border-border">
            <div className="space-y-1">
              <Label className="font-medium text-foreground">{t('updates.autoUpdateProjects')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('updates.autoUpdateProjectsDescription')}
              </p>
            </div>
            <Switch
              checked={settings.autoUpdateAutoBuild}
              onCheckedChange={(checked) =>
                onSettingsChange({ ...settings, autoUpdateAutoBuild: checked })
              }
            />
          </div>

          <div className="flex items-center justify-between p-4 rounded-lg border border-border">
            <div className="space-y-1">
              <Label className="font-medium text-foreground">{t('updates.betaUpdates')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('updates.betaUpdatesDescription')}
              </p>
            </div>
            <Switch
              checked={settings.betaUpdates ?? false}
              onCheckedChange={(checked) => {
                onSettingsChange({ ...settings, betaUpdates: checked });
                if (checked) {
                  // Clear downgrade info when enabling beta again
                  setStableDowngradeInfo(null);
                } else {
                  // Clear beta update info when disabling beta, so stable downgrade UI can show
                  setAppUpdateInfo(null);
                }
              }}
            />
          </div>

          {/* Stable Downgrade Section - shown when user turns off beta while on prerelease */}
          {stableDowngradeInfo && !appUpdateInfo && (
            <div className="rounded-lg border-2 border-warning/50 bg-warning/5 p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-warning">
                  <ArrowDownToLine className="h-5 w-5" />
                  <h3 className="font-semibold">{t('updates.stableDowngradeAvailable')}</h3>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={dismissStableDowngrade}
                  aria-label={t('common:accessibility.dismissAriaLabel')}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <p className="text-sm text-muted-foreground">
                {t('updates.stableDowngradeDescription')}
              </p>

              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
                    {t('updates.stableVersion')}
                  </p>
                  <p className="text-base font-medium text-foreground">
                    {stableDowngradeInfo.version}
                  </p>
                  {stableDowngradeInfo.releaseDate && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('updates.released')} {new Date(stableDowngradeInfo.releaseDate).toLocaleDateString()}
                    </p>
                  )}
                </div>
                <ArrowDownToLine className="h-6 w-6 text-warning" />
              </div>

              {/* Release Notes */}
              {stableDowngradeInfo.releaseNotes && (
                <div className="bg-background rounded-lg p-4 max-h-48 overflow-y-auto border border-border/50">
                  <ReleaseNotesRenderer content={stableDowngradeInfo.releaseNotes} />
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3">
                <Button
                  onClick={() => {
                    const url = stableDowngradeInfo?.version
                      ? `${GITHUB_RELEASES_URL}/tag/v${stableDowngradeInfo.version}`
                      : GITHUB_RELEASES_URL;
                    window.electronAPI.openExternal(url);
                  }}
                  variant="outline"
                >
                  <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('updates.viewOnGitHub')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={dismissStableDowngrade}
                >
                  {t('common:actions.dismiss')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </SettingsSection>
    );
  }

  // notifications section
  const notificationItems: Array<{
    key: keyof NotificationSettings;
    labelKey: string;
    descriptionKey: string;
  }> = [
    { key: 'onTaskComplete', labelKey: 'notifications.onTaskComplete', descriptionKey: 'notifications.onTaskCompleteDescription' },
    { key: 'onTaskFailed', labelKey: 'notifications.onTaskFailed', descriptionKey: 'notifications.onTaskFailedDescription' },
    { key: 'onReviewNeeded', labelKey: 'notifications.onReviewNeeded', descriptionKey: 'notifications.onReviewNeededDescription' },
    { key: 'onPRReviewComplete', labelKey: 'notifications.onPRReviewComplete', descriptionKey: 'notifications.onPRReviewCompleteDescription' },
    { key: 'onClaudeSessionComplete', labelKey: 'notifications.onClaudeSessionComplete', descriptionKey: 'notifications.onClaudeSessionCompleteDescription' },
    { key: 'sound', labelKey: 'notifications.sound', descriptionKey: 'notifications.soundDescription' }
  ];

  return (
    <SettingsSection
      title={t('notifications.title')}
      description={t('notifications.description')}
    >
      <div className="space-y-4">
        {notificationItems.map((item) => (
          <div key={item.key} className="flex items-center justify-between p-4 rounded-lg border border-border">
            <div className="space-y-1">
              <Label className="font-medium text-foreground">{t(item.labelKey)}</Label>
              <p className="text-sm text-muted-foreground">{t(item.descriptionKey)}</p>
            </div>
            <Switch
              checked={settings.notifications[item.key]}
              onCheckedChange={(checked) =>
                onSettingsChange({
                  ...settings,
                  notifications: {
                    ...settings.notifications,
                    [item.key]: checked
                  }
                })
              }
            />
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}
