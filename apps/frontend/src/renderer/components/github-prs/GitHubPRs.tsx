import { useState, useCallback, useEffect } from "react";
import { GitPullRequest, RefreshCw, ExternalLink, Settings, Play, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../stores/project-store";
import { useGitHubPRs, usePRFiltering } from "./hooks";
import type { PRData, PRReviewResult } from "./hooks/useGitHubPRs";
import { PRList, PRDetail, PRFilterBar } from "./components";
import { Button } from "../ui/button";
import { ResizablePanels } from "../ui/resizable-panels";

interface GitHubPRsProps {
  onOpenSettings?: () => void;
  isActive?: boolean;
  onDiscussInTerminal?: (pr: PRData, reviewResult: PRReviewResult) => void;
}

function NotConnectedState({
  error,
  onOpenSettings,
  t,
}: {
  error: string | null;
  onOpenSettings?: () => void;
  t: (key: string) => string;
}) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center max-w-md">
        <GitPullRequest className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
        <h3 className="text-lg font-medium mb-2">{t("prReview.notConnected")}</h3>
        <p className="text-sm text-muted-foreground mb-4">{error || t("prReview.connectPrompt")}</p>
        {onOpenSettings && (
          <Button onClick={onOpenSettings} variant="outline">
            <Settings className="h-4 w-4 mr-2" />
            {t("prReview.openSettings")}
          </Button>
        )}
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center text-muted-foreground">
        <GitPullRequest className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>{message}</p>
      </div>
    </div>
  );
}

export function GitHubPRs({ onOpenSettings, isActive = false, onDiscussInTerminal }: GitHubPRsProps) {
  const { t } = useTranslation("common");
  const projects = useProjectStore((state) => state.projects);
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  const {
    prs,
    isLoading,
    isLoadingMore,
    isLoadingPRDetails,
    error,
    selectedPRNumber,
    reviewResult,
    reviewProgress,
    startedAt,
    isReviewing,
    isExternalReview,
    previousReviewResult,
    reviewError,
    hasMore,
    selectPR,
    runReview,
    runFollowupReview,
    checkNewCommits,
    cancelReview,
    postReview,
    postComment,
    mergePR,
    assignPR,
    markReviewPosted,
    refresh,
    loadMore,
    isConnected,
    repoFullName,
    getReviewStateForPR,
    selectedPR,
  } = useGitHubPRs(selectedProject?.id, { isActive });

  // Get newCommitsCheck for the selected PR (other values come from hook to ensure consistency)
  const selectedPRReviewState = selectedPRNumber ? getReviewStateForPR(selectedPRNumber) : null;
  const storedNewCommitsCheck = selectedPRReviewState?.newCommitsCheck ?? null;

  // PR filtering
  const {
    filteredPRs,
    contributors,
    filters,
    setSearchQuery,
    setContributors,
    setStatuses,
    setSortBy,
    setDraftFilter,
    clearFilters,
    hasActiveFilters,
  } = usePRFiltering(prs, getReviewStateForPR);

  // Bulk selection state (always active — checkboxes always visible)
  const [checkedPRNumbers, setCheckedPRNumbers] = useState<Set<number>>(new Set());

  const handleToggleCheck = useCallback((prNumber: number) => {
    setCheckedPRNumbers(prev => {
      const next = new Set(prev);
      if (next.has(prNumber)) {
        next.delete(prNumber);
      } else {
        next.add(prNumber);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setCheckedPRNumbers(new Set(filteredPRs.map(pr => pr.number)));
  }, [filteredPRs]);

  const handleDeselectAll = useCallback(() => {
    setCheckedPRNumbers(new Set());
  }, []);

  const handleBulkReview = useCallback(() => {
    for (const prNumber of checkedPRNumbers) {
      const state = getReviewStateForPR(prNumber);
      const hasExistingReview = state?.result?.success;
      if (hasExistingReview) {
        runFollowupReview(prNumber);
      } else {
        runReview(prNumber);
      }
    }
    setCheckedPRNumbers(new Set());
  }, [checkedPRNumbers, runReview, runFollowupReview, getReviewStateForPR]);

  // Sync UI state when PR list updates (e.g., after auto-refresh from review completion)
  // Following pattern from PRDetail.tsx for state syncing
  useEffect(() => {
    // Ensure selected PR is still valid after list updates
    // This prevents stale state if a PR was closed/merged while selected
    if (selectedPRNumber && prs.length > 0) {
      const selectedStillExists = prs.some(pr => pr.number === selectedPRNumber);
      if (!selectedStillExists) {
        // Selected PR was removed/closed, clear selection to prevent stale state
        selectPR(null);
      }
    }
  }, [prs, selectedPRNumber, selectPR]);

  const handleRunReview = useCallback(() => {
    if (selectedPRNumber) {
      runReview(selectedPRNumber);
    }
  }, [selectedPRNumber, runReview]);

  const handleRunFollowupReview = useCallback(() => {
    if (selectedPRNumber) {
      runFollowupReview(selectedPRNumber);
    }
  }, [selectedPRNumber, runFollowupReview]);

  const handleCheckNewCommits = useCallback(async () => {
    if (selectedPRNumber) {
      return await checkNewCommits(selectedPRNumber);
    }
    return { hasNewCommits: false, newCommitCount: 0 };
  }, [selectedPRNumber, checkNewCommits]);

  const handleCancelReview = useCallback(() => {
    if (selectedPRNumber) {
      cancelReview(selectedPRNumber);
    }
  }, [selectedPRNumber, cancelReview]);

  const handlePostReview = useCallback(
    async (
      selectedFindingIds?: string[],
      options?: { forceApprove?: boolean }
    ): Promise<boolean> => {
      if (selectedPRNumber && reviewResult) {
        return await postReview(selectedPRNumber, selectedFindingIds, options);
      }
      return false;
    },
    [selectedPRNumber, reviewResult, postReview]
  );

  const handlePostComment = useCallback(
    async (body: string): Promise<boolean> => {
      if (selectedPRNumber) {
        return await postComment(selectedPRNumber, body);
      }
      return false;
    },
    [selectedPRNumber, postComment]
  );

  const handleMergePR = useCallback(
    async (mergeMethod?: "merge" | "squash" | "rebase") => {
      if (selectedPRNumber) {
        await mergePR(selectedPRNumber, mergeMethod);
      }
    },
    [selectedPRNumber, mergePR]
  );

  const handleAssignPR = useCallback(
    async (username: string) => {
      if (selectedPRNumber) {
        await assignPR(selectedPRNumber, username);
      }
    },
    [selectedPRNumber, assignPR]
  );

  const handleGetLogs = useCallback(async () => {
    if (selectedProjectId && selectedPRNumber) {
      return await window.electronAPI.github.getPRLogs(selectedProjectId, selectedPRNumber);
    }
    return null;
  }, [selectedProjectId, selectedPRNumber]);

  const handleMarkReviewPosted = useCallback(async (prNumber: number) => {
    await markReviewPosted(prNumber);
  }, [markReviewPosted]);

  const handleDiscussInTerminal = useCallback(() => {
    if (selectedPR && reviewResult && onDiscussInTerminal) {
      onDiscussInTerminal(selectedPR, reviewResult);
    }
  }, [selectedPR, reviewResult, onDiscussInTerminal]);

  // Not connected state
  if (!isConnected) {
    return <NotConnectedState error={error} onOpenSettings={onOpenSettings} t={t} />;
  }

  return (
    <div className="flex-1 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium flex items-center gap-2">
            <GitPullRequest className="h-4 w-4" />
            {t("prReview.pullRequests")}
          </h2>
          {repoFullName && (
            <a
              href={`https://github.com/${repoFullName}/pulls`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              {repoFullName}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
          <span className="text-xs text-muted-foreground">
            {prs.length} {t("prReview.open")}
          </span>
        </div>
        <Button variant="ghost" size="icon" onClick={refresh} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Bulk action bar — shows when PRs are checked */}
      {checkedPRNumbers.size > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/50">
          <Button variant="ghost" size="sm" onClick={checkedPRNumbers.size === filteredPRs.length ? handleDeselectAll : handleSelectAll}>
            {checkedPRNumbers.size === filteredPRs.length ? t("prReview.deselectAll") : t("prReview.selectAll")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("prReview.selectedCount", { count: checkedPRNumbers.size })}
          </span>
          <Button variant="default" size="sm" onClick={handleBulkReview}>
            <Play className="h-3 w-3 mr-1" />
            {t("prReview.reviewSelected", { count: checkedPRNumbers.size })}
          </Button>
          <Button variant="ghost" size="icon" className="ml-auto h-7 w-7" onClick={handleDeselectAll}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {/* Content - Resizable split panels */}
      <ResizablePanels
        defaultLeftWidth={50}
        minLeftWidth={30}
        maxLeftWidth={70}
        storageKey="github-prs-panel-width"
        leftPanel={
          <div className="flex flex-col h-full">
            <PRFilterBar
              filters={filters}
              contributors={contributors}
              hasActiveFilters={hasActiveFilters}
              onSearchChange={setSearchQuery}
              onContributorsChange={setContributors}
              onStatusesChange={setStatuses}
              onSortChange={setSortBy}
              onDraftFilterChange={setDraftFilter}
              onClearFilters={clearFilters}
            />
            <PRList
              prs={filteredPRs}
              selectedPRNumber={selectedPRNumber}
              isLoading={isLoading}
              hasMore={hasMore}
              error={error}
              getReviewStateForPR={getReviewStateForPR}
              onSelectPR={selectPR}
              onLoadMore={loadMore}
              isLoadingMore={isLoadingMore}
              checkedPRNumbers={checkedPRNumbers}
              onToggleCheck={handleToggleCheck}
            />
          </div>
        }
        rightPanel={
          selectedPR ? (
            <PRDetail
              pr={selectedPR}
              projectId={selectedProjectId || ""}
              reviewResult={reviewResult}
              previousReviewResult={previousReviewResult}
              reviewProgress={reviewProgress}
              startedAt={startedAt}
              isReviewing={isReviewing}
              isExternalReview={isExternalReview}
              reviewError={reviewError}
              initialNewCommitsCheck={storedNewCommitsCheck}
              isActive={isActive}
              isLoadingFiles={isLoadingPRDetails}
              onRunReview={handleRunReview}
              onRunFollowupReview={handleRunFollowupReview}
              onCheckNewCommits={handleCheckNewCommits}
              onCancelReview={handleCancelReview}
              onPostReview={handlePostReview}
              onPostComment={handlePostComment}
              onMergePR={handleMergePR}
              onAssignPR={handleAssignPR}
              onGetLogs={handleGetLogs}
              onMarkReviewPosted={handleMarkReviewPosted}
              onDiscussInTerminal={onDiscussInTerminal ? handleDiscussInTerminal : undefined}
            />
          ) : (
            <EmptyState message={t("prReview.selectPRToView")} />
          )
        }
      />
    </div>
  );
}
