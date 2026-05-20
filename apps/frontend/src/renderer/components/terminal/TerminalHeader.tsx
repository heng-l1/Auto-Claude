import { useCallback, useRef, useState } from 'react';
import { X, Sparkles, TerminalSquare, FolderGit, ExternalLink, GripVertical, Maximize2, Minimize2, RotateCcw, Globe, ClipboardCheck, Loader2, Repeat } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import type { Task, TerminalWorktreeConfig } from '../../../shared/types';
import type { ManualPRReviewFinding } from '@shared/types/pr-review-comments';
import type { TerminalStatus } from '../../stores/terminal-store';
import { useTerminalStore } from '../../stores/terminal-store';
import { useProjectStore } from '../../stores/project-store';
import { useToast } from '../../hooks/use-toast';
import { DEFAULT_REMOTE_PROCESSES } from '../../../shared/constants/terminal';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { STATUS_COLORS } from './types';
import { TerminalTitle } from './TerminalTitle';
import { TaskSelector } from './TaskSelector';
import { WorktreeSelector } from './WorktreeSelector';
import { ExtractFindingsConfirmDialog } from '../github-prs/components/ExtractFindingsConfirmDialog';

interface TerminalHeaderProps {
  terminalId: string;
  title: string;
  status: TerminalStatus;
  isClaudeMode: boolean;
  tasks: Task[];
  associatedTask?: Task;
  onClose: () => void;
  onInvokeClaude: () => void;
  /** Callback to open the Ralph Loop launcher dialog */
  onRalphLoop?: () => void;
  onTitleChange: (newTitle: string) => void;
  onTaskSelect: (taskId: string) => void;
  onClearTask: () => void;
  onNewTaskClick?: () => void;
  terminalCount?: number;
  /** Worktree configuration if terminal is associated with a worktree */
  worktreeConfig?: TerminalWorktreeConfig;
  /** Project path for worktree operations */
  projectPath?: string;
  /** Callback to open worktree creation dialog */
  onCreateWorktree?: () => void;
  /** Callback when an existing worktree is selected */
  onSelectWorktree?: (config: TerminalWorktreeConfig) => void;
  /** Callback to open worktree in IDE */
  onOpenInIDE?: () => void;
  /** Current foreground process name from PTY (e.g., 'ssh', 'tmux') */
  foregroundProcess?: string;
  /** Merged set of default + custom remote process names */
  remoteProcesses?: Set<string>;
  /** Drag handle listeners for terminal reordering */
  dragHandleListeners?: SyntheticListenerMap;
  /** Whether the terminal is expanded to full view */
  isExpanded?: boolean;
  /** Callback to toggle expanded state */
  onToggleExpand?: () => void;
  /** Whether this terminal has a pending Claude resume (deferred until tab activated) */
  pendingClaudeResume?: boolean;
  /** Whether Claude is idle (waiting for user input) */
  isClaudeIdle?: boolean;
  /** Whether this terminal has a pending activity alert (Claude went busy->idle while not active) */
  hasActivityAlert?: boolean;
}

export function TerminalHeader({
  terminalId,
  title,
  status,
  isClaudeMode,
  tasks,
  associatedTask,
  onClose,
  onInvokeClaude,
  onRalphLoop,
  onTitleChange,
  onTaskSelect,
  onClearTask,
  onNewTaskClick,
  terminalCount = 1,
  worktreeConfig,
  projectPath,
  onCreateWorktree,
  onSelectWorktree,
  onOpenInIDE,
  foregroundProcess,
  remoteProcesses,
  dragHandleListeners,
  isExpanded,
  onToggleExpand,
  pendingClaudeResume,
  isClaudeIdle,
  hasActivityAlert,
}: TerminalHeaderProps) {
  const { t } = useTranslation(['terminal', 'common']);
  const { toast } = useToast();
  const backlogTasks = tasks.filter((t) => t.status === 'backlog');

  // Check if 2+ terminals have pending Claude resume
  // Use a derived selector returning a primitive to avoid re-renders on unrelated terminal changes
  const pendingResumeCount = useTerminalStore(
    (state) => state.terminals.filter((t) => t.pendingClaudeResume === true).length
  );
  const showResumeAllButton = pendingResumeCount >= 2;

  // Use provided remoteProcesses or fall back to defaults
  const processesToCheck = remoteProcesses || DEFAULT_REMOTE_PROCESSES;
  const isInRemoteSession = !!foregroundProcess && processesToCheck.has(foregroundProcess);

  // PR discussion context flags this terminal as a PR review session — mirror of
  // the gating used by App.tsx's "Discuss in Terminal" flow (App.tsx:879) and the
  // memory-extraction path (terminal-lifecycle.ts:295). When set, expose the
  // "Capture findings to PR review" button so the user can promote terminal
  // observations into the PR review surface without leaving the terminal.
  const prDiscussionContext = useTerminalStore(
    (state) => state.terminals.find((tm) => tm.id === terminalId)?.prDiscussionContext
  );
  // Resolve the project id from the path so `ExtractFindingsConfirmDialog` can
  // route `addManualFinding` writes to the right `.auto-claude/github/pr/` slot.
  const projectId = useProjectStore((state) =>
    projectPath ? state.projects.find((p) => p.path === projectPath)?.id : undefined
  );

  // Extract-findings dialog state. `candidates: null` is the dialog's "loading"
  // mode (spinner with the prReview.extractDialog.extracting copy). We bump
  // `extractRunIdRef` on every cancel/new-extract so a slow IPC response from a
  // prior run cannot overwrite a fresh dialog state once the user has cancelled
  // or kicked off another extraction.
  const [extractDialogOpen, setExtractDialogOpen] = useState(false);
  const [extractedCandidates, setExtractedCandidates] = useState<ManualPRReviewFinding[] | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const extractRunIdRef = useRef(0);

  const handleCaptureFindings = useCallback(async () => {
    if (!prDiscussionContext || isExtracting) return;
    const runId = ++extractRunIdRef.current;
    setIsExtracting(true);
    setExtractedCandidates(null);
    setExtractDialogOpen(true);
    try {
      const candidates = await window.electronAPI.github.pr.manualFindings.extract(
        terminalId,
        prDiscussionContext.prNumber,
      );
      // Drop the result if a later run (or a cancel) has superseded this one.
      if (extractRunIdRef.current !== runId) return;
      setExtractedCandidates(candidates);
    } catch (err) {
      if (extractRunIdRef.current !== runId) return;
      toast({
        title: t('common:prReview.extractDialog.capture'),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
      setExtractDialogOpen(false);
    } finally {
      if (extractRunIdRef.current === runId) {
        setIsExtracting(false);
      }
    }
  }, [terminalId, prDiscussionContext, isExtracting, toast, t]);

  const handleExtractCancel = useCallback(() => {
    // Invalidate the in-flight extract so its eventual resolution is ignored.
    extractRunIdRef.current += 1;
    setIsExtracting(false);
    setExtractDialogOpen(false);
    setExtractedCandidates(null);
  }, []);

  return (
    <>
      <div className="electron-no-drag group/header flex h-9 items-center justify-between border-b border-border/50 bg-card/30 px-2">
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          {/* Drag handle - visible on hover */}
          {dragHandleListeners && (
            <div
              {...dragHandleListeners}
              className={cn(
                'flex items-center justify-center',
                'w-4 h-6 -ml-1',
                'opacity-0 group-hover/header:opacity-60',
                'hover:opacity-100 transition-opacity',
                'cursor-grab active:cursor-grabbing',
                'text-muted-foreground hover:text-foreground'
              )}
            >
              <GripVertical className="h-3.5 w-3.5" />
            </div>
          )}
          <div className={cn('h-2 w-2 rounded-full', STATUS_COLORS[status])} />
          <div className="flex items-center gap-1.5">
            <TerminalSquare className="h-3.5 w-3.5 text-muted-foreground" />
            <TerminalTitle
              title={title}
              associatedTask={associatedTask}
              onTitleChange={onTitleChange}
              terminalCount={terminalCount}
            />
          </div>
          {isClaudeMode && (
            <span
              className="flex items-center gap-1 text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded"
              title="Claude"
            >
              <Sparkles className="h-2.5 w-2.5" />
              {terminalCount < 4 && <span>Claude</span>}
            </span>
          )}
          {pendingClaudeResume && (
            <span
              className="flex items-center gap-1 text-[10px] font-medium text-cyan-500 bg-cyan-500/10 px-1.5 py-0.5 rounded animate-pulse"
              title={t('terminal:resume.pendingTooltip')}
            >
              <RotateCcw className="h-2.5 w-2.5" />
              {terminalCount < 4 && <span>{t('terminal:resume.pending')}</span>}
            </span>
          )}
          {isClaudeIdle && (
            <span
              className="flex items-center gap-1 text-[10px] font-medium text-green-500 bg-green-500/10 px-1.5 py-0.5 rounded"
              title={t('terminal:claude.waitingForInput')}
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
              </span>
              {terminalCount < 4 && <span>{t('terminal:claude.waitingForInput')}</span>}
            </span>
          )}
          {hasActivityAlert && (
            <span
              className="flex items-center gap-1 text-[10px] font-medium text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded"
              title={t('terminal:activity.completed')}
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
              </span>
              {terminalCount < 4 && <span>{t('terminal:activity.completed')}</span>}
            </span>
          )}
          {foregroundProcess && processesToCheck.has(foregroundProcess) && (
            <span
              className="flex items-center gap-1 text-[10px] font-medium text-blue-400 bg-blue-400/10 px-1.5 py-0.5 rounded"
              title={t('terminal:remoteSession.badge', { process: foregroundProcess })}
            >
              <Globe className="h-2.5 w-2.5" />
              {terminalCount < 4 && <span>{foregroundProcess}</span>}
            </span>
          )}
          <TaskSelector
            terminalId={terminalId}
            backlogTasks={backlogTasks}
            associatedTask={associatedTask}
            onTaskSelect={onTaskSelect}
            onClearTask={onClearTask}
            onNewTaskClick={onNewTaskClick}
          />
          {/* Worktree selector or badge - placed next to task selector */}
          {worktreeConfig ? (
            <span
              className={cn(
                'flex items-center gap-1 text-[10px] font-medium text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded',
                terminalCount >= 6 ? 'max-w-20' : terminalCount >= 4 ? 'max-w-28' : 'max-w-40'
              )}
              title={worktreeConfig.name}
            >
              <FolderGit className="h-2.5 w-2.5 flex-shrink-0" />
              <span className="truncate">{worktreeConfig.name}</span>
            </span>
          ) : (
            projectPath && onCreateWorktree && onSelectWorktree && (
              <WorktreeSelector
                terminalId={terminalId}
                projectPath={projectPath}
                currentWorktree={worktreeConfig}
                onCreateWorktree={onCreateWorktree}
                onSelectWorktree={onSelectWorktree}
              />
            )
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {/* Resume All button - shown when 2+ terminals have pending resume */}
          {showResumeAllButton && (
            <Button
              variant="ghost"
              size={terminalCount >= 4 ? 'icon' : 'sm'}
              className={cn(
                'h-6 hover:bg-cyan-500/10 hover:text-cyan-500 animate-pulse',
                terminalCount >= 4 ? 'w-6' : 'px-2 text-xs gap-1',
                'text-cyan-500 bg-cyan-500/10'
              )}
              onClick={(e) => {
                e.stopPropagation();
                useTerminalStore.getState().resumeAllPendingClaude();
              }}
              title={t('terminal:resume.resumeAllSessions')}
            >
              <RotateCcw className="h-3 w-3" />
              {terminalCount < 4 && <span>{t('terminal:resume.resumeAllSessions')}</span>}
            </Button>
          )}
          {/* Capture findings to PR review — visible only when this terminal is
              tagged as a PR discussion (mirror of App.tsx's "Discuss in Terminal"
              gating). Clicking runs the Haiku scrollback extractor over the PTY
              output buffer and opens ExtractFindingsConfirmDialog with the
              candidate findings. */}
          {prDiscussionContext && (
            <Button
              variant="ghost"
              size={terminalCount >= 4 ? 'icon' : 'sm'}
              className={cn(
                'h-6 hover:bg-primary/10 hover:text-primary',
                terminalCount >= 4 ? 'w-6' : 'px-2 text-xs gap-1'
              )}
              onClick={(e) => {
                e.stopPropagation();
                void handleCaptureFindings();
              }}
              disabled={isExtracting}
              title={
                isExtracting
                  ? t('common:prReview.extractDialog.extracting')
                  : t('common:prReview.extractDialog.capture')
              }
            >
              {isExtracting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ClipboardCheck className="h-3 w-3" />
              )}
              {terminalCount < 4 && (
                <span>
                  {isExtracting
                    ? t('common:prReview.extractDialog.extracting')
                    : t('common:prReview.extractDialog.capture')}
                </span>
              )}
            </Button>
          )}
          {/* Open in IDE button when worktree exists */}
          {worktreeConfig && onOpenInIDE && (
            <Button
              variant="ghost"
              size={terminalCount >= 4 ? 'icon' : 'sm'}
              className={cn(
                'h-6 hover:bg-muted',
                terminalCount >= 4 ? 'w-6' : 'px-2 text-xs gap-1'
              )}
              onClick={(e) => {
                e.stopPropagation();
                onOpenInIDE();
              }}
              title={t('terminal:worktree.openInIDE')}
            >
              <ExternalLink className="h-3 w-3" />
              {terminalCount < 4 && t('terminal:worktree.openInIDE')}
            </Button>
          )}
          {(!isClaudeMode || isInRemoteSession) && status !== 'exited' && (
            <Button
              variant="ghost"
              size={terminalCount >= 4 ? 'icon' : 'sm'}
              className={cn(
                'h-6 hover:bg-primary/10 hover:text-primary',
                terminalCount >= 4 ? 'w-6' : 'px-2 text-xs gap-1'
              )}
              onClick={(e) => {
                e.stopPropagation();
                onInvokeClaude();
              }}
              title="Claude"
            >
              <Sparkles className="h-3 w-3" />
              {terminalCount < 4 && <span>Claude</span>}
            </Button>
          )}
          {status !== 'exited' && onRalphLoop && (
            <Button
              variant="ghost"
              size={terminalCount >= 4 ? 'icon' : 'sm'}
              className={cn(
                'h-6 hover:bg-primary/10 hover:text-primary',
                terminalCount >= 4 ? 'w-6' : 'px-2 text-xs gap-1'
              )}
              onClick={(e) => {
                e.stopPropagation();
                onRalphLoop();
              }}
              title={t('terminal:ralphLoop.buttonTitle')}
            >
              <Repeat className="h-3 w-3" />
              {terminalCount < 4 && <span>{t('terminal:ralphLoop.buttonLabel')}</span>}
            </Button>
          )}
          {/* Expand/collapse button */}
          {onToggleExpand && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 hover:bg-muted"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand();
              }}
              title={`${isExpanded ? t('terminal:expand.collapse') : t('terminal:expand.expand')} (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Shift+E)`}
            >
              {isExpanded ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 hover:bg-destructive/10 hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            title={`${t('common:close')} (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+W)`}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {prDiscussionContext && projectId && (
        <ExtractFindingsConfirmDialog
          open={extractDialogOpen}
          onOpenChange={setExtractDialogOpen}
          candidates={extractedCandidates}
          isLoading={isExtracting}
          onCancel={handleExtractCancel}
          projectId={projectId}
          prNumber={prDiscussionContext.prNumber}
        />
      )}
    </>
  );
}