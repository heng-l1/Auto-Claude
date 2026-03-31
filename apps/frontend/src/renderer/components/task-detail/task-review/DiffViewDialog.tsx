import { useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, MessageSquare, Layers } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Button } from '../../ui/button';
import { Badge } from '../../ui/badge';
import { DiffFileTree } from './DiffFileTree';
import { DiffCodeViewer } from './DiffCodeViewer';
import { ResizablePanels } from '../../ui/resizable-panels';
import type { WorktreeDiff, SubtaskDiff, ReviewComment } from '../../../../shared/types';
import '../../../styles/diff-viewer.css';

interface DiffViewDialogProps {
  open: boolean;
  worktreeDiff: WorktreeDiff | null;
  subtaskDiffs?: SubtaskDiff[];
  onOpenChange: (open: boolean) => void;
  onRequestChanges?: (feedback: string) => void;
}

/** Truncate a subtask description for display in a tab */
function truncateDescription(desc: string, maxLen: number = 40): string {
  if (desc.length <= maxLen) return desc;
  return `${desc.slice(0, maxLen)}…`;
}

/**
 * Full-screen PR-style diff viewer dialog.
 * Replaces the original AlertDialog with a two-panel layout:
 * left sidebar file tree + right-panel code diff viewer with inline commenting.
 *
 * Now supports per-subtask diff tabs: "Overall" shows the full diff, and each
 * subtask tab shows only that subtask's changes (commit range).
 */
export function DiffViewDialog({
  open,
  worktreeDiff,
  subtaskDiffs,
  onOpenChange,
  onRequestChanges,
}: DiffViewDialogProps) {
  const { t } = useTranslation(['taskReview', 'common']);

  // --- State ---
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [comments, setComments] = useState<Map<string, ReviewComment[]>>(
    new Map()
  );
  // Active diff tab: 'overall' or a subtask ID
  const [activeDiffTab, setActiveDiffTab] = useState<string>('overall');

  // Determine which diff to display based on active tab
  const activeDiff = useMemo(() => {
    if (activeDiffTab === 'overall') {
      return worktreeDiff;
    }
    const subtask = subtaskDiffs?.find((sd) => sd.subtaskId === activeDiffTab);
    return subtask?.diff ?? null;
  }, [activeDiffTab, worktreeDiff, subtaskDiffs]);

  const files = activeDiff?.files ?? [];
  const selectedFile = files[selectedFileIndex] ?? null;

  // Whether we have subtask diffs to show tabs
  const hasSubtaskDiffs = (subtaskDiffs?.length ?? 0) > 0;

  /** Total number of comments across all files */
  const totalCommentCount = useMemo(() => {
    let count = 0;
    for (const threadComments of comments.values()) {
      count += threadComments.length;
    }
    return count;
  }, [comments]);

  /** Whether there are any unsaved comments (prevents accidental close) */
  const hasComments = totalCommentCount > 0;

  // --- Reset state when dialog opens ---
  useEffect(() => {
    if (open) {
      setSelectedFileIndex(0);
      setComments(new Map());
      setActiveDiffTab('overall');
    }
  }, [open]);

  // --- Reset file selection when switching tabs ---
  useEffect(() => {
    setSelectedFileIndex(0);
  }, [activeDiffTab]);

  // --- Keyboard navigation (ArrowUp / ArrowDown for file selection) ---
  useEffect(() => {
    if (!open || files.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture arrows when focus is inside a textarea or input
      const activeEl = document.activeElement;
      if (
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLInputElement
      ) {
        return;
      }
      // Skip when file tree listbox has focus — DiffFileTree handles its own keyboard nav
      if (
        activeEl?.getAttribute('role') === 'listbox' ||
        activeEl?.closest('[role="listbox"]')
      ) {
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedFileIndex((prev) => Math.min(prev + 1, files.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedFileIndex((prev) => Math.max(prev - 1, 0));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, files.length]);

  // --- Comment management ---

  /** Add a new inline comment */
  const handleAddComment = useCallback(
    (
      filePath: string,
      lineNumber: number,
      side: 'old' | 'new',
      content: string
    ) => {
      const key = `${filePath}:${lineNumber}:${side}`;
      const newComment: ReviewComment = {
        id: crypto.randomUUID(),
        filePath,
        lineNumber,
        side,
        content,
        createdAt: new Date(),
      };

      setComments((prev) => {
        const next = new Map(prev);
        const existing = next.get(key) || [];
        next.set(key, [...existing, newComment]);
        return next;
      });
    },
    []
  );

  /** Delete an existing comment by ID */
  const handleDeleteComment = useCallback((commentId: string) => {
    setComments((prev) => {
      const next = new Map(prev);
      for (const [key, threadComments] of next) {
        const filtered = threadComments.filter((c) => c.id !== commentId);
        if (filtered.length === 0) {
          next.delete(key);
        } else if (filtered.length !== threadComments.length) {
          next.set(key, filtered);
        }
      }
      return next;
    });
  }, []);

  // --- Request Changes ---

  /** Format all comments as structured markdown and invoke the callback */
  const handleRequestChanges = useCallback(() => {
    if (!onRequestChanges || totalCommentCount === 0) return;

    const lines: string[] = ['## Review Comments', ''];

    // Collect all comments across all threads, sorted by file path then line number
    const allComments: ReviewComment[] = [];
    for (const threadComments of comments.values()) {
      allComments.push(...threadComments);
    }
    allComments.sort((a, b) => {
      const pathCmp = a.filePath.localeCompare(b.filePath);
      if (pathCmp !== 0) return pathCmp;
      return a.lineNumber - b.lineNumber;
    });

    for (const comment of allComments) {
      lines.push(
        `**${comment.filePath}:${comment.lineNumber}** — ${comment.content}`
      );
    }

    onRequestChanges(lines.join('\n'));
  }, [onRequestChanges, totalCommentCount, comments]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[95vw] w-full h-[90vh] p-0 gap-0 flex flex-col"
        onInteractOutside={(e) => {
          if (hasComments) {
            e.preventDefault();
          }
        }}
      >
        {/* Header */}
        <DialogHeader className="px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <DialogTitle className="flex items-center gap-2">
                <Eye className="h-5 w-5 text-purple-400" />
                {t('taskReview:diffViewer.title', 'Code Changes')}
              </DialogTitle>
              {totalCommentCount > 0 && (
                <Badge
                  variant="purple"
                  className="px-1.5 py-0 text-[0.625rem] leading-4 gap-0.5"
                >
                  <MessageSquare className="h-2.5 w-2.5" />
                  {totalCommentCount}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 mr-8">
              {onRequestChanges && (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={totalCommentCount === 0}
                  onClick={handleRequestChanges}
                  title={
                    totalCommentCount === 0
                      ? t(
                          'taskReview:diffViewer.requestChangesDisabled',
                          'Add inline comments to request changes'
                        )
                      : undefined
                  }
                >
                  {t(
                    'taskReview:diffViewer.requestChanges',
                    'Request Changes'
                  )}
                </Button>
              )}
            </div>
          </div>
          <DialogDescription className="sr-only">
            {activeDiff?.summary ||
              t('taskReview:diffViewer.noChanges', 'No changes found')}
          </DialogDescription>
        </DialogHeader>

        {/* Subtask diff tabs — only shown when subtask diffs are available */}
        {hasSubtaskDiffs && (
          <div className="px-4 py-2 border-b border-border bg-muted/20 shrink-0 overflow-x-auto">
            <div className="flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <div className="flex gap-1 min-w-0">
                {/* Overall tab */}
                <button
                  type="button"
                  onClick={() => setActiveDiffTab('overall')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
                    activeDiffTab === 'overall'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  {t('taskReview:diffViewer.overallTab', 'Overall')}
                  {worktreeDiff && (
                    <span className="ml-1.5 opacity-70">
                      ({worktreeDiff.files.length})
                    </span>
                  )}
                </button>

                {/* Per-subtask tabs */}
                {subtaskDiffs?.map((sd, idx) => (
                  <button
                    type="button"
                    key={sd.subtaskId}
                    onClick={() => setActiveDiffTab(sd.subtaskId)}
                    title={sd.subtaskDescription}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors max-w-[200px] truncate ${
                      activeDiffTab === sd.subtaskId
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    <span className="opacity-70 mr-1">#{idx + 1}</span>
                    {truncateDescription(sd.subtaskDescription, 30)}
                    <span className="ml-1.5 opacity-70">
                      ({sd.diff.files.length})
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Two-panel layout */}
        <ResizablePanels
          defaultLeftWidth={20}
          minLeftWidth={10}
          maxLeftWidth={40}
          storageKey="diff-viewer-sidebar-width"
          className="flex-1 min-h-0"
          leftPanel={
            <DiffFileTree
              files={files}
              selectedIndex={selectedFileIndex}
              comments={comments}
              onSelectFile={setSelectedFileIndex}
            />
          }
          rightPanel={
            <div className="diff-viewer-main">
              {/* File header bar */}
              {selectedFile && (
                <div className="diff-viewer-header">
                  <div className="diff-viewer-header-info">
                    <span className="diff-viewer-header-filename">
                      {selectedFile.path}
                    </span>
                  </div>
                  <div className="diff-viewer-header-actions">
                    <span className="text-xs text-success">
                      +{selectedFile.additions}
                    </span>
                    <span className="text-xs text-destructive">
                      -{selectedFile.deletions}
                    </span>
                  </div>
                </div>
              )}

              {/* Diff code viewer */}
              <DiffCodeViewer
                file={selectedFile}
                comments={comments}
                onAddComment={handleAddComment}
                onDeleteComment={handleDeleteComment}
              />
            </div>
          }
        />
      </DialogContent>
    </Dialog>
  );
}
