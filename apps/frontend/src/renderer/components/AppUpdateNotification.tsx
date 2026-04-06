import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import type { AppUpdateAvailableEvent } from "../../shared/types";

const CLAUDE_CODE_CHANGELOG_URL =
  "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md";

const GITHUB_RELEASES_URL = "https://github.com/heng-l1/Auto-Claude/releases";

// createSafeLink - factory function that creates a SafeLink component with i18n support
const createSafeLink = (opensInNewWindowText: string) => {
  return function SafeLink({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
    // Validate URL - only allow http, https, and relative links
    const isValidUrl =
      href &&
      (href.startsWith("http://") ||
        href.startsWith("https://") ||
        href.startsWith("/") ||
        href.startsWith("#"));

    if (!isValidUrl) {
      // For invalid or potentially malicious URLs, render as plain text
      return <span className="text-muted-foreground">{children}</span>;
    }

    // External links get security attributes and accessibility indicator
    const isExternal = href?.startsWith("http://") || href?.startsWith("https://");

    return (
      <a
        href={href}
        {...props}
        {...(isExternal && {
          target: "_blank",
          rel: "noopener noreferrer",
        })}
        className="text-primary hover:underline"
      >
        {children}
        {isExternal && <span className="sr-only"> {opensInNewWindowText}</span>}
      </a>
    );
  };
};

/**
 * App Update Notification Dialog
 * Shows when a new app version is available and directs users to GitHub releases
 */
export function AppUpdateNotification() {
  const { t } = useTranslation(["dialogs", "common"]);
  const [isOpen, setIsOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateAvailableEvent | null>(null);

  // Create markdown components with translated accessibility text
  const markdownComponents: Components = useMemo(
    () => ({
      a: createSafeLink(t("common:accessibility.opensInNewWindow")),
    }),
    [t]
  );

  // Listen for update available event
  useEffect(() => {
    const cleanup = window.electronAPI.onAppUpdateAvailable((info) => {
      setUpdateInfo(info);
      setIsOpen(true);
    });

    return cleanup;
  }, []);

  const handleViewOnGitHub = () => {
    const url = updateInfo?.version
      ? `${GITHUB_RELEASES_URL}/tag/v${updateInfo.version}`
      : GITHUB_RELEASES_URL;
    window.electronAPI.openExternal(url);
  };

  const handleDismiss = () => {
    setIsOpen(false);
  };

  if (!updateInfo) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ExternalLink className="h-5 w-5" />
            {t("dialogs:appUpdate.title", "New Version Available")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "dialogs:appUpdate.description",
              "A new version of Auto Claude is available on GitHub"
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Version Info */}
          <div className="rounded-lg border border-border bg-muted/50 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
                  {t("dialogs:appUpdate.newVersion", "New Version")}
                </p>
                <p className="text-base font-medium text-foreground">{updateInfo.version}</p>
                {updateInfo.releaseDate && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {t("dialogs:appUpdate.released", "Released")}{" "}
                    {new Date(updateInfo.releaseDate).toLocaleDateString()}
                  </p>
                )}
              </div>
              <ExternalLink className="h-6 w-6 text-info" />
            </div>
          </div>

          {/* Release Notes */}
          {updateInfo.releaseNotes && (
            <div className="bg-background rounded-lg p-4 max-h-64 overflow-y-auto border border-border/50">
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeRaw, rehypeSanitize]}
                  components={markdownComponents}
                >
                  {updateInfo.releaseNotes}
                </ReactMarkdown>
              </div>
            </div>
          )}

          {/* Claude Code Changelog Link */}
          <Button
            variant="link"
            size="sm"
            className="w-full text-xs text-muted-foreground gap-1"
            onClick={() => window.electronAPI.openExternal(CLAUDE_CODE_CHANGELOG_URL)}
            aria-label={t(
              "dialogs:appUpdate.claudeCodeChangelogAriaLabel",
              "View Claude Code Changelog (opens in new window)"
            )}
          >
            {t("dialogs:appUpdate.claudeCodeChangelog", "View Claude Code Changelog")}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </Button>
        </div>

        <DialogFooter className="flex flex-col sm:flex-row gap-3">
          <Button variant="outline" onClick={handleDismiss}>
            {t("dialogs:appUpdate.remindMeLater", "Remind Me Later")}
          </Button>

          <Button onClick={handleViewOnGitHub}>
            <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
            {t("dialogs:appUpdate.viewOnGitHub", "View on GitHub")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
